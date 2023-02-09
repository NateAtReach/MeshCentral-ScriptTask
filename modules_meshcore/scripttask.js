/** 
* @description MeshCentral ScriptTask plugin
* @author Ryan Blenis
* @copyright 
* @license Apache-2.0
*/

"use strict";

var JobState = {
    SCHEDULED: 1,
    DISPATCHED: 2,
    PENDING: 3,
    RUNNING: 4,
    COMPLETE: 5,
};

/**
 * A job execution instruction
 * @typedef {Object} Job
 * @property {string} jobId - unique idenfitier for the job.
 * @property {string} scriptId - unique identifier for the script to execute.
 * @property {Object} replaceVars - Collection of variable replacements.
 * @property {string} scriptHash - hash of the script contents.
 * @property {number} dispatchTime - time the job was dispatched by server. UTC millis
 * @property {string} sessionId - session ID the job was run on
 * 
 * @property {number|undefined} scriptPid - OS process ID of the script (if executing)
 * @property {JobState} state - state of the job
 * @property {number|undefined} utcStartedAt - UTC millis of when job started running
 * @property {number|undefined} utcCompletedAt - UTC millis of when the job completed
 * @property {string|undefined} randomName - random string used to save script and output to disk
 * @property {number|undefined} abortTimer - setTimeout handle used to abort the running script
 * @property {number|undefined} downloadStallTimer - setTimeout to handle download stall
 */

var mesh;
var db = require('SimpleDataStore').Shared();
var pendingDownload = [];
/** @type Array<Job> */
var jobQueue = [];
/** @type Array<Job> */
var logFileNameMatcher = /^scripttask-([1-9][0-9]{7})\.log$/;
var options = {
    powershellHandler: {
        value: 'runPowerShell2',
        options: [ 'runPowerShell2' ]
    },
    retainTempFiles: {
        value: 'off',
        options: [ 'on', 'off' ]
    },
    swallowNextDownload: {
        value: 'off',
        options: [ 'on', 'off' ]
    }
};
var powershellHandlers = {
    runPowerShell2: runPowerShell2
};
var jobQueueHealthCheckTimer = null;
var fs = require('fs');
var child_process = require('child_process');

/**
 * Encodes str into unicode code bytes and returns a base64 representation.
 * 
 * This implement does not handle code points, etc. As such, input should be limited to ASCII.
 * 
 * @param {string} str 
 * @returns {string}
 */
function strToPowershellEncodedCommand(str) {
    var buf = new ArrayBuffer(str.length * 2);
    var bufView = new Uint16Array(buf);
    for (var i = 0, strLen = str.length; i < strLen; i++) {
        bufView[i] = str.charCodeAt(i);
    }
    return new Buffer(new Uint8Array(buf)).toString('base64');
}

/**
 * Returns true if thing is exactly null or has type undefined.
 * @param {*} thing 
 * @returns 
 */
function isNullish(thing) {
    return typeof thing === 'undefined' || null === thing;
}

/**
 * Formats provided Date object as YYYYMMDD
 * @param {Date} date 
 * @returns {string}
 */
function getYyyyMmDd(date) {
    var mm = date.getMonth() + 1; // getMonth() is zero-based
    var dd = date.getDate();
  
    return [date.getFullYear(),
            (mm>9 ? '' : '0') + mm,
            (dd>9 ? '' : '0') + dd
           ].join('');
}

/**
 * writes a log message to the current day's log file.
 * 
 * @param {string} str 
 */
var log = function(str) {
    var today = getYyyyMmDd(new Date());
    var todayLogFile = 'scripttask-' + today + '.log';
    var logFilePath = 'plugin_data\\scripttask\\logs\\' + todayLogFile;

    var logStream = fs.createWriteStream(logFilePath, {'flags': 'a'});
    
    logStream.end(new Date().toLocaleString() + ': ' + str.replace('\r', '[CR]').replace('\n', '[LF]') + '\n');
}

Array.prototype.remove = function(from, to) {
  var rest = this.slice((to || from) + 1 || this.length);
  this.length = from < 0 ? this.length + from : from;
  return this.push.apply(this, rest);
};

/**
 * Deletes temp script files older than -30 days.
 */
function cleanScriptFolder() {
    var thirtyDaysAgo = new Date().setDate(new Date().getDate() - 30);

    fs.readdirSync('./plugin_data/scripttask/temp').forEach(function(file) {
        try {
            var filePath = './plugin_data/scripttask/temp/' + file;
            var fileStat = fs.statSync(filePath);
            if(fileStat.ctime.getTime() <= thirtyDaysAgo) {
                fs.unlinkSync(filePath);
            }
        } catch(e) {}
    });
}

/**
 * Deletes log files older than -7 days.
 */
function cleanLogFolder() {
    var sevenDaysAgo = 19700101;

    try {
        var sevenDaysAgo = parseInt(getYyyyMmDd(new Date(Date.now() - 604800000)));
    } catch(e) {
    }

    fs.readdirSync('./plugin_data/scripttask/logs').forEach(function(file) {
        //log file format: scripttask-YYYYMMDD.log
        logFileNameMatcher.lastIndex = 0;
        var match = logFileNameMatcher.exec(file);
        if(null !== match && match.length > 0) {
            try {
			    var fileDate = parseInt(match[1]);
                if(fileDate <= sevenDaysAgo) {
                    var logToDelete = 'plugin_data\\scripttask\\logs\\' + file;
                    fs.unlinkSync(logToDelete);
                }
            } catch(e) {}
        }
    });
}

/**
 * creates plugin_data/scripttask/logs folder and plugin_data/scripttask/temp folder if they do not
 * exist.
 */
function setupPluginDataFolder() {
    if(!fs.existsSync('./plugin_data')) {
        fs.mkdirSync('./plugin_data');
    }

    if(!fs.existsSync('./plugin_data/scripttask')) {
        fs.mkdirSync('./plugin_data/scripttask');
    }

    if(!fs.existsSync('./plugin_data/scripttask/logs')) {
        fs.mkdirSync('./plugin_data/scripttask/logs');
    }

    if(!fs.existsSync('./plugin_data/scripttask/temp')) {
        fs.mkdirSync('./plugin_data/scripttask/temp');
    }
}

/**
 * Finds the specified job in the queue
 * @param {string} jobId - id of job to find in the queue
 * @returns {Job|undefined}
 */
function getJobById(jobId) {
    return jobQueue.find(function(job) {
        return job.jobId === jobId;
    });
}

/**
 * Adds the job to the job queue. Returns true if the job was added, false if the job already
 * exists.
 * @param {Job} job 
 * @returns {boolean}
 */
function enqueueJob(job) {
    if(getJobById(job.jobId)) {
        return false;
    }

    jobQueue.push(job);

    return true;
}

/**
 * Returns the next job in the specified state
 * @param {JobState[keyof JobState]|undefined} state - state to look. Default: JobState.PENDING
 * @returns {Job|undefined}
 */
function getNextJobInState(state) {
    if(typeof state === 'undefined') {
        state = JobState.PENDING;
    }

    return jobQueue.find(function(job) {
        return job.state === state;
    });
}

/**
 * Removes stale job entries from the front of the queue.
 */
function pruneJobQueue() {
    log('pruning job queue');

    //remove old job definitions from the front of the queue.

    var fifteenMinutesAgo = Date.now() - 900000;
    var twentyFiveMinutesAgo = fifteenMinutesAgo - 1500000;

    var firstJob = jobQueue.length > 0 ? jobQueue[0] : undefined;
    while(typeof firstJob !== 'undefined') {
        var completedStale = typeof firstJob.utcCompletedAt === 'number' && firstJob.utcCompletedAt <= fifteenMinutesAgo;
        var startedStale = typeof firstJob.utcStartedAt === 'number' && firstJob.utcStartedAt <= twentyFiveMinutesAgo;

        if(completedStale || startedStale) {
            log('removing stale job queue item (jobId=' + firstJob.jobId + ', state=' + firstJob.state + ')');

            jobQueue.shift();
        } else {
            break;
        }

        firstJob = jobQueue.length > 0 ? jobQueue[0] : undefined;
    }
}

/**
 * Returns the number of jobs in the queue
 * @param {Array<JobState[keyof JobState]>|undefined} states - states to include in count. Default: all but COMPLETE
 * @returns {number}
 */
function getJobCount(states) {
    if(typeof states === 'undefined') {
        states = [
            JobState.PENDING,
            JobState.RUNNING
        ];
    }

    var count = 0;
    jobQueue.forEach(function(job) {
        if(states.indexOf(job.state) > -1) {
            ++count;
        }
    });

    return count;
}

/**
 * @template T
 * @template [U = T]
 * @param { function(T, Job): U } func
 * @param {T} initialValue
 * @returns {T}
 */
function jobQueueReduce(func, initialValue) {
    return jobQueue.reduce(func, initialValue);
}

function startJobQueueHealthCheck() {
    if(!isNullish(jobQueueHealthCheckTimer)) {
        return;
    }

    log('starting job queue health check');

    //set an interval to check for stalled run job loop. if we have > 0 pending and < 1 running, we
    //should start the loop again.
    jobQueueHealthCheckTimer = setInterval(function() {
        try {
            pruneJobQueue();

            var result = jobQueueReduce(
                function(memo, job) {
                    return {
                        pending: memo.pending + (job.state === JobState.PENDING ? 1 : 0),
                        running: memo.running + (job.state === JobState.RUNNING ? 1 : 0)
                    };
                },
                { running: 0, pending: 0 }
            );

            if(result.pending > 0 && result.running < 1) {
                log('WARNING: detected stalled job execution loop; restarting queue processor');
                runNextJob();
            } else {
                log('job queue processor is healthy');
            }
        } catch(e) {
            var message = e ? (e.message ? e.message : e.toString() ) : 'UNKNOWN';
            log('ERROR: failed to check job queue processor health; reason=' + message);
        }
    }, 60000);
}

/**
 * Callback executed if a download takes too long to be received
 * @param {Job} job 
 */
function onDownloadTimeout(job) {
    log('WARNING: timeout occured (jobId=' + job.jobId + ') while waiting for script to download');

    //remove from pending downloads
    pendingDownload.forEach(
        /**
         * @param {Job} pd 
         * @param {*} k 
         */
        function(pd, k) {
            if (pd.jobId === job.jobId) {
                pendingDownload.remove(k);
            }
        }
    );

    //finalize the job
    finalizeJob(job, undefined, "timed out waiting for script to download");
}

/**
 * Runs the next pending job in the job queue.
 */
function runNextJob() {
    pruneJobQueue();

    log('there are ' + getJobCount() + ' job(s) in the queue');

    var runningJob = getNextJobInState(JobState.RUNNING);
    if(typeof runningJob !== 'undefined') {
        log('there is a job already running; terminating this job queue loop');

        return;
    }

    var nextJob = getNextJobInState(JobState.PENDING);
    if(typeof nextJob === 'undefined') {
        log('there are no more jobs to run');

        return;
    }

    log('running job (jobId=' + nextJob.jobId + ') in state PENDING');

    nextJob.state = JobState.RUNNING;
    nextJob.utcStartedAt = Date.now();

    mesh.SendCommand({
        "action": "plugin", 
        "plugin": "scripttask",
        "pluginaction": "updateJobState",
        "jobId": nextJob.jobId,
        "scriptId": nextJob.scriptId,
        "newState": JobState.RUNNING,
        "sessionid": nextJob.sessionId,
        "tag": "console"
    });

    var sObj = getScriptFromCache(nextJob.scriptId);

    if (sObj == null || sObj.contentHash != nextJob.scriptHash) {
        log('fetching script (scriptId=' + nextJob.scriptId + ') from the server');

        // get from the server, then run
        mesh.SendCommand({
            "action": "plugin", 
            "plugin": "scripttask",
            "pluginaction": "getScript",
            "scriptId": nextJob.scriptId, 
            "sessionid": nextJob.sessionId,
            "tag": "console"
        });

        nextJob.downloadStallTimer = setTimeout(function() {
            onDownloadTimeout(nextJob);
        }, 30000);

        pendingDownload.push(nextJob);

        log('there are now ' + pendingDownload.length + ' pending download(s)');
    } else {
        // ready to run
        runScript(sObj, nextJob);
    }
}

/**
 * Handler for events arriving from Mesh server.
 * @param {*} args - event arguments
 * @param {*} rights - unknown
 * @param {string} sessionid - session id
 * @param {*} parent - mesh server object
 * @returns 
 */
function consoleaction(args, rights, sessionid, parent) {
    if (typeof args['_'] == 'undefined') {
        args['_'] = [];
        args['_'][1] = args.pluginaction;
        args['_'][2] = null;
        args['_'][3] = null;
        args['_'][4] = null;
    }
    
    var fnname = args['_'][1];
    mesh = parent;

    startJobQueueHealthCheck();
    setupPluginDataFolder();
    cleanLogFolder();
    
    switch (fnname) {
        case 'triggerJob':
        {
            log('triggerJob (jobId=' + args.jobId + ', scriptId=' + args.scriptId + ', scriptHash=' + args.scriptHash + ', dispatchTime=' + args.dispatchTime + ')');

            pruneJobQueue();

            var existingJob = getJobById(args.jobId);
            if(typeof existingJob !== 'undefined') {
                log('jobId ' + existingJob.jobId + ' already exists in state ' + existingJob.state + '; ignoring trigger');

                break;
            }

            //we'll clean the script folder each time a job is run
            cleanScriptFolder();

            /** @type {Job} */
            var jObj = { 
                jobId: args.jobId,
                scriptId: args.scriptId,
                replaceVars: args.replaceVars,
                scriptHash: args.scriptHash,
                dispatchTime: args.dispatchTime,
                sessionId: sessionid,
                state: JobState.PENDING,
                randomName: Math.random().toString(32).replace('0.', '')
            };

            mesh.SendCommand({
                "action": "plugin", 
                "plugin": "scripttask",
                "pluginaction": "updateJobState",
                "jobId": args.jobId,
                "scriptId": args.scriptId,
                "newState": JobState.PENDING,
                "sessionid": args.sessionId,
                "tag": "console"
            });

            if(enqueueJob(jObj)) {
                log('enqueued job (jobId=' + jObj.jobId + ')');

                runNextJob();
            } else {
                log('failed to enqueue job (jobId=' + jObj.jobId + ')');
            }

            break;
        }
        case 'cacheScript':
        {
            var sObj = args.script;

            if(options.swallowNextDownload.value === 'on') {
                options.swallowNextDownload.value = 'off';

                log('swallowingNextDownload is "on". ignoring cacheScript request for scriptId=' + sObj._id);

                return;
            }

            log('caching script with id ' + sObj._id);

            cacheScript(sObj);

            var setRun = [];
            if (pendingDownload.length > 0) {
                log('searching for pending script executions depending on script with id' + sObj._id);

                pendingDownload.forEach(
                    /**
                     * 
                     * @param {Job} pd 
                     * @param {*} k 
                     */
                    function(pd, k) { 
                        if (pd.scriptId === sObj._id && pd.scriptHash === sObj.contentHash) {
                            if (setRun.indexOf(pd) === -1) {
                                log('resuming pending execution (jobId=' + pd.jobId + ')');

                                if(typeof pd.downloadStallTimer !== 'undefined') {
                                    clearTimeout(pd.downloadStallTimer);
                                    pd.downloadStallTimer = undefined;
                                }

                                runScript(sObj, pd);

                                setRun.push(pd);
                            }

                            pendingDownload.remove(k);
                        }
                    }
                );
            }

            break;
        }
        case 'clearAll':
            clearCache();

            mesh.SendCommand({ 
                "action": "plugin", 
                "plugin": "scripttask",
                "pluginaction": "clearAllPendingJobs",
                "sessionid": sessionid,
                "tag": "console"
            });

            return 'Cache cleared. All pending jobs cleared.';
        case 'clearCache':
            clearCache();

            return 'The script cache has been cleared';
        case 'logCommandArgs':
            var argsAsString = JSON.stringify(args);
            log('logCommandArgs: ' + argsAsString);
            return JSON.stringify(argsAsString);
        case 'getOpt':
            var optName = args['_'][2];

            var optionKeys = Object.keys(options);
            if(optionKeys.indexOf(optName) === -1) {
                var message = 'invalid option "' + optName + '". Valid option names are: "' + optionKeys.join('", "') + '"';

                log('getOpt: ' + message);

                return message;
            }

            var message = 'option "' + optName + '" set to "' + options[optName].value + '"';

            log('getOpt: ' + message);

            return message;
        case 'setOpt':
            var optName = args['_'][2];
            var optValue = args['_'][3];

            var optionKeys = Object.keys(options);
            if(optionKeys.indexOf(optName) === -1) {
                var message = 'invalid option "' + optName + '". Valid option names are: "' + optionKeys.join('", "') + '"';

                log('setOpt: ' + message);

                return message;
            }

            var validOptions = options[optName].options;
            if(validOptions.indexOf(optValue) === -1) {
                var message = 'invalid value "' + optValue + '" for option "' + optName + '". Valid choices are: "' + validOptions.join('", "') + '"';

                log('setOpt: ' + message);

                return message;
            }

            options[optName].value = optValue;

            var message = 'option "' + optName + '" set to "' + optValue + '"';

            log('setOpt: ' + message);

            return message;
        case 'getPendingJobs':
        {
            var ret = '';
            if (pendingDownload.length == 0) {
                return "No jobs pending script download";
            }

            pendingDownload.forEach(function(pd, k) {     
                ret += 'Job ' + k + ': ' + 'JobID: ' + pd.jobId + ' ScriptID: ' + pd.scriptId;
            });

            return ret;
        }
        default:
            log('Unknown action: '+ fnname + ' with data ' + JSON.stringify(args));
            break;
    }
}

/**
 * 
 * @param {Job} job 
 * @param {*} retVal 
 * @param {*} errVal 
 */
function finalizeJob(job, retVal, errVal) {
    job.utcCompletedAt = Date.now();
    job.state = JobState.COMPLETE;

    if (!isNullish(errVal) && !isNullish(errVal.stack)) {
        errVal = errVal.stack;
    }

    if(!isNullish(job.downloadStallTimer)) {
        log('WARNING: found dangling downloadStallTimer on job (jobId=' + job.jobId + ')');

        clearTimeout(job.downloadStallTimer);
        job.downloadStallTimer = undefined;
    }

    if(!isNullish(job.abortTimer)) {
        log('WARNING: found dangling abortTimer on job (jobId=' + job.jobId + ')');

        clearTimeout(job.abortTimer);
        job.abortTimer = undefined;
    }

    log('finalizing job (jobId=' + job.jobId + ', scriptId=' + job.scriptId + ')');

    mesh.SendCommand({ 
        "action": "plugin", 
        "plugin": "scripttask",
        "pluginaction": "jobComplete",
        "jobId": job.jobId,
        "scriptId": job.scriptId,
        "retVal": retVal,
        "errVal": errVal,
        "dispatchTime": job.dispatchTime, // include original run time (long running tasks could have tried a re-send)
        "sessionid": job.sessionId,
        "tag": "console"
    });

    runNextJob();
}

function unlinkTempFiles(files) {
    if(options.retainTempFiles.value === 'on') {
        return;
    }

    files.forEach(function(file) {
        try {
            log('removing file ' + file);
            fs.unlinkSync(file);
        } catch (e) {
            var message = e ? (e.message ? e.message : e.toString() ) : 'UNKNOWN';
            log('WARNING: failed to unlink file ' + file + '; reason=' + message);
        }
    });
}

/**
 * 
 * @param {*} sObj 
 * @param {Job} jObj 
 */
function runPowerShell2(sObj, jObj) {
    if (process.platform != 'win32') {
        throw new Error('powershell is not supported on this OS');
    }

    var jobId = jObj.jobId;
    var scriptId = sObj._id;

    var outputPath = 'plugin_data\\scripttask\\temp\\st' + jObj.randomName + '.txt';
    var scriptPath = 'plugin_data\\scripttask\\temp\\st' + jObj.randomName + '.ps1';

    var clearAbortTimer = function() {
        if(typeof jObj.abortTimer !== 'undefined') {
            clearTimeout(jObj.abortTimer);
            jObj.abortTimer = undefined;
        }
    };

    jObj.abortTimer = setTimeout(function() {
        clearAbortTimer();

        //TODO: abort long-running process
        log('todo: kill long-running process ' + jObj.scriptPid);

        finalizeJob(jObj, undefined, "The process failed to execute in a timely manner");
    }, 600000);

    try {
        log('writing script (scriptId=' + scriptId + ', jobId=' + jobId + ') to ' + scriptPath);
        fs.writeFileSync(scriptPath, sObj.content);

        var outstr = '', errstr = '';

        var buffer = strToPowershellEncodedCommand('$ProgressPreference = "SilentlyContinue"\r\n.\\' + scriptPath + ' | Out-File ' + outputPath + ' -Encoding UTF8');
        var invocationParams = ['-NonInteractive', '-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', buffer.toString('base64')];
        var powershellPath = process.env['windir'] + '\\system32\\WindowsPowerShell\\v1.0\\powershell.exe';

        log('creating powershell process for job id ' + jobId + '(powershellPath=' + powershellPath + ',invocationParams=' + JSON.stringify(invocationParams) + ')');
        var child = child_process.execFile(
            powershellPath,
            invocationParams
        );

        jObj.scriptPid = child.pid;

        child.stderr.on('data', function (chunk) { errstr += chunk; });
        child.stdout.on('data', function (chunk) { });

        child.stdout.on('close', function() {
            log('received stdout close from pid ' + child.pid);
        });

        log('powershell process (pid=' + child.pid + ') successfully created for job id ' + jobId);

        child.on('error', function(err) {
            log('ERROR: child process ' + child.pid + ' failed; reason=' + err.message);
        });

        child.on('exit', function(procRetVal, procRetSignal) {
            clearAbortTimer();

            log('powershell (pid=' + child.pid + ', jobId=' + jobId + ') exited with code ' + procRetVal + ', signal: ' + procRetSignal); 

            if (errstr !== '') {
                log('job completed with errors; stderr: ' + errstr);

                finalizeJob(jObj, null, errstr);

                unlinkTempFiles([ outputPath, scriptPath ]);

                return;
            }

            if (procRetVal > 0) {
                log('the powershell process temrinated unexpectedly');

                finalizeJob(jObj, null, 'Process terminated unexpectedly.');

                unlinkTempFiles([ outputPath, scriptPath ]);

                return;
            }

            try {
                log('reading script output file ' + outputPath);

                outstr = fs.readFileSync(outputPath, 'utf8').toString();
            } catch (e) {
                var message = e ? (e.message ? e.message : e.toString() ) : 'UNKNOWN';
                log('failed to read output file ' + outputPath + '; reason=' + message);

                outstr = (procRetVal) ? 'Failure' : 'Success';
            }

            if (outstr) {
                try {
                    outstr = outstr.trim();
                } catch (e) { }
            } else {
                outstr = (procRetVal) ? 'Failure' : 'Success';
            }

            log('job with id ' + jobId + ' produced ' + outstr.length + ' output characters(s)');

            finalizeJob(jObj, outstr);

            unlinkTempFiles([ outputPath, scriptPath ]);
        });
    } catch (e) { 
        clearAbortTimer();

        var message = e ? (e.message ? e.message : e.toString() ) : 'UNKNOWN';
        log('failed to execute script via powershell; reason=' + message);

        finalizeJob(jObj, null, e);

        unlinkTempFiles([ outputPath, scriptPath ]);
    }
}

function runBat(sObj, jObj) {
    finalizeJob(jObj, null, 'Platform not supported.');
}

function runBash(sObj, jObj) {
    finalizeJob(jObj, null, 'Platform not supported.');
}

/**
 * 
 * @param {*} sObj 
 * @param {Job} jObj 
 */
function runScript(sObj, jObj) {
    log('executing script (scriptId=' + sObj._id + ', jobId=' + jObj.jobId + ')');

    if (null !== jObj.replaceVars) {
        log('replacing variables in script');

        Object.getOwnPropertyNames(jObj.replaceVars).forEach(function(key) {
            var val = jObj.replaceVars[key];
            sObj.content = sObj.content.replace(new RegExp('#'+key+'#', 'g'), val);
        });

        sObj.content = sObj.content.replace(new RegExp('#(.*?)#', 'g'), 'VAR_NOT_FOUND');
    }

    switch (sObj.filetype) {
        case 'ps1':
            var handler = powershellHandlers[options.powershellHandler.value];
            handler(sObj, jObj);
        break;
        case 'bat':
            runBat(sObj, jObj);
        break;
        case 'bash':
            runBash(sObj, jObj);
        break;
        default:
            log('unknown filetype: '+ sObj.filetype);
        break;
    }
}

function getScriptFromCache(id) {
    var scriptKey = 'pluginScriptTask_script_' + id;

    log('fetching script with key ' + scriptKey);

    var script = db.Get(scriptKey);
    if (script == '' || script == null) {
        log('script key ' + scriptKey + ' not found in cache');

        return null;
    }

    try {
        return JSON.parse(script);
    } catch (e) {
        var message = e ? (e.message ? e.message : e.toString() ) : 'UNKNOWN';
        log('ERROR: failed to parse script with key ' + scriptKey + '; reason=' + message);
    }

    return null;
}

function cacheScript(sObj) {
    db.Put('pluginScriptTask_script_' + sObj._id, sObj);
}

function clearCache() {
    db.Keys.forEach(function(k) {
        if (k.indexOf('pluginScriptTask_script_') === 0) {
            db.Put(k, null);
            db.Delete(k);
        }
    });
}

module.exports = { consoleaction : consoleaction };