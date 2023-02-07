/** 
* @description MeshCentral ScriptTask plugin
* @author Ryan Blenis
* @copyright 
* @license Apache-2.0
*/

"use strict";

var mesh;
var obj = this;
var _sessionid; //global, yuck
var isWsconnection = false;
var wscon = null;
var db = require('SimpleDataStore').Shared();
var pendingDownload = [];
var runningJobs = [];
var runningJobPIDs = {};
var logFileNameMatcher = /^scripttask-([1-9][0-9]{7})\.log$/;
var fs = require('fs');
var child_process = require('child_process');

function isNullish(thing) {
    return typeof thing === 'undefined' || null === thing;
}

function getYyyyMmDd(date) {
    var mm = date.getMonth() + 1; // getMonth() is zero-based
    var dd = date.getDate();
  
    return [date.getFullYear(),
            (mm>9 ? '' : '0') + mm,
            (dd>9 ? '' : '0') + dd
           ].join('');
}

var log = function(str) {
    var today = getYyyyMmDd(new Date());
    var todayLogFile = 'scripttask-' + today + '.log';
    var logFilePath = 'plugin_data\\scripttask\\logs\\' + todayLogFile;

    var logStream = fs.createWriteStream(logFilePath, {'flags': 'a'});
    
    logStream.end(new Date().toLocaleString()+': '+ str.replace('\r', '[CR]').replace('\n', '[LF]') + '\n');
}

Array.prototype.remove = function(from, to) {
  var rest = this.slice((to || from) + 1 || this.length);
  this.length = from < 0 ? this.length + from : from;
  return this.push.apply(this, rest);
};

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
    if(!fs.existsSync('./plugin_data/scripttask/logs')) {
        fs.mkdirSync('./plugin_data/scripttask/logs', { recursive: true });
    }

    if(!fs.existsSync('./plugin_data/scripttask/temp')) {
        fs.mkdirSync('./plugin_data/scripttask/temp', { recursive: true });
    }
}

function consoleaction(args, rights, sessionid, parent) {
    isWsconnection = false;
    wscon = parent;
    _sessionid = sessionid;

    if (typeof args['_'] == 'undefined') {
        args['_'] = [];
        args['_'][1] = args.pluginaction;
        args['_'][2] = null;
        args['_'][3] = null;
        args['_'][4] = null;
        isWsconnection = true;
    }
    
    var fnname = args['_'][1];
    mesh = parent;

    setupPluginDataFolder();
    cleanLogFolder();
    
    switch (fnname) {
        case 'triggerJob':
        {
            //we'll clean the script folder each time a job is run
            cleanScriptFolder();

            var jObj = { 
                jobId: args.jobId,
                scriptId: args.scriptId,
                replaceVars: args.replaceVars,
                scriptHash: args.scriptHash,
                dispatchTime: args.dispatchTime
            };

            log('triggerJob (jobId=' + args.jobId + ', scriptId=' + args.scriptId + ', scriptHash=' + args.scriptHash + ', dispatchTime=' + args.dispatchTime + ')');
            
            var sObj = getScriptFromCache(jObj.scriptId);

            if (sObj == null || sObj.contentHash != jObj.scriptHash) {
                log('fetching script (scriptId=' + sObj.scriptId + ') from the server');

                // get from the server, then run
                mesh.SendCommand({
                    "action": "plugin", 
                    "plugin": "scripttask",
                    "pluginaction": "getScript",
                    "scriptId": jObj.scriptId, 
                    "sessionid": _sessionid,
                    "tag": "console"
                });

                pendingDownload.push(jObj);

                log('there are now ' + pendingDownload.length + ' pending download(s)');
            } else {
                // ready to run
                runScript(sObj, jObj);
            }

            break;
        }
        case 'cacheScript':
        {
            var sObj = args.script;

            log('caching script with id ' + sObj._id);

            cacheScript(sObj);

            var setRun = [];
            if (pendingDownload.length > 0) {
                log('searching for pending script executions depending on script with id' + sObj._id);

                pendingDownload.forEach(function(pd, k) { 
                    if (pd.scriptId === sObj._id && pd.scriptHash === sObj.contentHash) {
                        if (setRun.indexOf(pd) === -1) {
                            log('resuming pending execution (jobId=' + pd.jobId + ')');

                            runScript(sObj, pd);

                            setRun.push(pd);
                        }

                        pendingDownload.remove(k);
                    }
                });
            }

            break;
        }
        case 'clearAll':
            clearCache();

            mesh.SendCommand({ 
                "action": "plugin", 
                "plugin": "scripttask",
                "pluginaction": "clearAllPendingJobs",
                "sessionid": _sessionid,
                "tag": "console"
            });

            return 'Cache cleared. All pending jobs cleared.';
        case 'clearCache':
            clearCache();

            return 'The script cache has been cleared';
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

function finalizeJob(job, retVal, errVal) {
    if (!isNullish(errVal) && !isNullish(errVal.stack)) {
        errVal = errVal.stack;
    }

    log('finalizing job (jobId=' + job.jobId + ', scriptId=' + job.scriptId + ')');
    
    runningJobs.remove(runningJobs.indexOf(job.jobId));

    if (typeof runningJobPIDs[job.jobId] != 'undefined') {
        delete runningJobPIDs[job.jobId];
    }

    mesh.SendCommand({ 
        "action": "plugin", 
        "plugin": "scripttask",
        "pluginaction": "jobComplete",
        "jobId": job.jobId,
        "scriptId": job.scriptId,
        "retVal": retVal,
        "errVal": errVal,
        "dispatchTime": job.dispatchTime, // include original run time (long running tasks could have tried a re-send)
        "sessionid": _sessionid,
        "tag": "console"
    });
}

//@TODO Test powershell on *nix devices with and without powershell installed
function runPowerShell(sObj, jObj) {
    if (process.platform != 'win32') {
        return runPowerShellNonWin(sObj, jObj);
    }

    var jobId = jObj.jobId;
    var scriptId = sObj._id;

    var rand =  Math.random().toString(32).replace('0.', '');
    
    var outputPath = 'plugin_data\\scripttask\\temp\\st' + rand + '.txt';
    var scriptPath = 'plugin_data\\scripttask\\temp\\st' + rand + '.ps1';

    var unlinkTempFiles = function() {
        try {
            log('removing output file ' + outputPath);
            fs.unlinkSync(outputPath);
        } catch (e) {
            const message = e ? (e.message ? e.message : e.toString() ) : 'UNKNOWN';
            log('WARNING: failed to unlink output file ' + outputPath + '; reason=' + message);
        }

        try {
            fs.unlinkSync(scriptPath);
        } catch(e) {
            const message = e ? (e.message ? e.message : e.toString() ) : 'UNKNOWN';
            log('WARNING: failed to unlink script file ' + scriptPath + '; reason=' + message);
        }
    };
    
    try {
        log('writing script (scriptId=' + scriptId + ', jobId=' + jobId + ') to ' + scriptPath);
        fs.writeFileSync(scriptPath, sObj.content);

        var outstr = '', errstr = '';

        log('creating powershell process for job id ' + jobId);
        var child = child_process.execFile(process.env['windir'] + '\\system32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoLogo', '-ExecutionPolicy Bypass'] );

        child.stderr.on('data', function (chunk) { errstr += chunk; });
        child.stdout.on('data', function (chunk) { });

        runningJobPIDs[jObj.jobId] = child.pid;

        log('powershell process (pid=' + child.pid + ') successfully created for job id ' + jobId);

        child.on('exit', function(procRetVal, procRetSignal) {
            log('powershell (pid=' + child.pid + ', jobId=' + jobId + ') exited with code ' + procRetVal + ', signal: ' + procRetSignal); 

            if (errstr !== '') {
                log('job completed with errors; stderr: ' + errstr);

                finalizeJob(jObj, null, errstr);

                unlinkTempFiles();

                return;
            }

            if (procRetVal > 0) {
                log('the powershell process temrinated unexpectedly');

                finalizeJob(jObj, null, 'Process terminated unexpectedly.');

                unlinkTempFiles();

                return;
            }

            try {
                log('reading script output file ' + outputPath);

                outstr = fs.readFileSync(outputPath, 'utf8').toString();
            } catch (e) {
                const message = e ? (e.message ? e.message : e.toString() ) : 'UNKNOWN';
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

            unlinkTempFiles();
        });

        var scriptInvocation = '.\\' + scriptPath + ' | Out-File ' + outputPath + ' -Encoding UTF8\r\n';
        log('writing script invocation to powershell stdin; invocation=' + scriptInvocation);

        child.stdin.write(scriptInvocation);
        child.stdin.write('exit\r\n');
    } catch (e) { 
        const message = e ? (e.message ? e.message : e.toString() ) : 'UNKNOWN';
        log('failed to execute script via powershell; reason=' + message);

        finalizeJob(jObj, null, e);

        unlinkTempFiles();
    }
}

function runPowerShellNonWin(sObj, jObj) {
    var rand =  Math.random().toString(32).replace('0.', '');
    
    var path = '';
    var pathTests = [
        '/usr/local/mesh',
        '/tmp',
        '/usr/local/mesh_services/meshagent', 
        '/var/tmp'
    ];
    pathTests.forEach(function(p) {
        if (path == '' && fs.existsSync(p)) { path = p; }
    });
    log('Path chosen is: ' + path);
    path = path + '/';
    
    var oName = 'st' + rand + '.txt';
    var pName = 'st' + rand + '.ps1';
    var pwshout = '', pwsherr = '', cancontinue = false;
    try {
        var childp = child_process.execFile('/bin/sh', ['sh']);
        childp.stderr.on('data', function (chunk) { pwsherr += chunk; });
        childp.stdout.on('data', function (chunk) { pwshout += chunk; });
        childp.stdin.write('which pwsh' + '\n');
        childp.stdin.write('exit\n');
        childp.waitExit();
    } catch (e) { finalizeJob(jObj, null, "Couldn't determine pwsh in env: " + e); }
    if (pwsherr != '') {
        finalizeJob(jObj, null, "PowerShell env determination error: " + pwsherr);
        return;
    }
    if (pwshout.trim() != '') {
        cancontinue = true;
    }
    if (cancontinue === false) { finalizeJob(jObj, null, "PowerShell is not installed"); return; }
    try {
        fs.writeFileSync(path + pName, '#!' + pwshout + '\n' + sObj.content.split('\r\n').join('\n').split('\r').join('\n'));
        var outstr = '', errstr = '';
        var child = child_process.execFile('/bin/sh', ['sh']);
        child.stderr.on('data', function (chunk) { errstr += chunk; });
        child.stdout.on('data', function (chunk) { });
        runningJobPIDs[jObj.jobId] = child.pid;
        
        child.stdin.write('cd ' + path + '\n');                                                                                                                                                
        child.stdin.write('chmod a+x ' + pName + '\n');                                                                                                                                        
        child.stdin.write('./' + pName + ' > ' + oName + '\n');
        child.on('exit', function(procRetVal, procRetSignal) {
            if (errstr != '') {
                finalizeJob(jObj, null, errstr);
                try {
                    fs.unlinkSync(path + oName);
                    fs.unlinkSync(path + pName);
                } catch (e) { log('Could not unlink files, error was: ' + e + ' for path ' + path); }
                return;
            }
            if (procRetVal == 1) {
                finalizeJob(jObj, null, 'Process terminated unexpectedly.');
                try {
                    fs.unlinkSync(path + oName);
                    fs.unlinkSync(path + pName);
                } catch (e) { log('Could not unlink files1, error was: ' + e + ' for path ' + path); }
                return;
            }
            try { 
                outstr = fs.readFileSync(path + oName, 'utf8').toString();
            } catch (e) { outstr = (procRetVal) ? 'Failure' : 'Success'; }
            if (outstr) {
                //outstr = outstr.replace(/[^\x20-\x7E]/g, ''); 
                try { outstr = outstr.trim(); } catch (e) { }
            } else {
                outstr = (procRetVal) ? 'Failure' : 'Success';
            }
            log('Output is: ' + outstr);
            finalizeJob(jObj, outstr);
            try {
                fs.unlinkSync(path + oName);
                fs.unlinkSync(path + pName);
            } catch (e) { log('Could not unlink files2, error was: ' + e + ' for path ' + path); }
        });
        child.stdin.write('exit\n');
    } catch (e) { 
        log('Error block was (PowerShellNonWin): ' + e);
        finalizeJob(jObj, null, e);
    }
}

function runBat(sObj, jObj) {
    if (process.platform != 'win32') {
        finalizeJob(jObj, null, 'Platform not supported.');
        return;
    }

    var rand =  Math.random().toString(32).replace('0.', '');
    var oName = 'st' + rand + '.txt';
    var pName = 'st' + rand + '.bat';
    try {
        fs.writeFileSync(pName, sObj.content);
        var outstr = '', errstr = '';
        var child = child_process.execFile(process.env['windir'] + '\\system32\\cmd.exe');
        child.stderr.on('data', function (chunk) { errstr += chunk; });
        child.stdout.on('data', function (chunk) { });
        runningJobPIDs[jObj.jobId] = child.pid;
        child.stdin.write(pName + ' > ' + oName + '\r\n');
        child.stdin.write('exit\r\n');

        child.on('exit', function(procRetVal, procRetSignal) {
            if (errstr != '') {
                try { 
                    fs.unlinkSync(oName);
                    fs.unlinkSync(pName);
                } catch (e) { log('Could not unlink files, error was: ' + e); }
                finalizeJob(jObj, null, errstr);
                return;
            }
            if (procRetVal == 1) {
                try { 
                    fs.unlinkSync(oName);
                    fs.unlinkSync(pName);
                } catch (e) { log('Could not unlink files, error was: ' + e); }
                finalizeJob(jObj, null, 'Process terminated unexpectedly.');
                return;
            }
            try { 
                outstr = fs.readFileSync(oName, 'utf8').toString();
            } catch (e) { outstr = (procRetVal) ? 'Failure' : 'Success'; }
            if (outstr) {
                //outstr = outstr.replace(/[^\x20-\x7E]/g, ''); 
                try { outstr = outstr.trim(); } catch (e) { }
            } else {
                outstr = (procRetVal) ? 'Failure' : 'Success';
            }
            log('Output is: ' + outstr);
            try {
                fs.unlinkSync(oName);
                fs.unlinkSync(pName);
            } catch (e) { log('Could not unlink files, error was: ' + e); }
            finalizeJob(jObj, outstr);
        });
    } catch (e) { 
        log('Error block was (BAT): ' + e);
        finalizeJob(jObj, null, e);
    }
}

function runBash(sObj, jObj) {
    if (process.platform == 'win32') {
        finalizeJob(jObj, null, 'Platform not supported.');
        return;
    }
    //dbg('proc is ' + JSON.stringify(process));
    var path = '';
    var pathTests = [
        '/usr/local/mesh',
        '/tmp',
        '/usr/local/mesh_services/meshagent', 
        '/var/tmp'
    ];
    pathTests.forEach(function(p) {
        if (path == '' && fs.existsSync(p)) { path = p; }
    });
    log('Path chosen is: ' + path);
    path = path + '/';
    //var child = require('child_process');
    //child.execFile(process.env['windir'] + '\\system32\\cmd.exe', ['/c', 'RunDll32.exe user32.dll,LockWorkStation'], { type: 1 });
    
    var rand =  Math.random().toString(32).replace('0.', '');
    var oName = 'st' + rand + '.txt';
    var pName = 'st' + rand + '.sh';
    try {
        fs.writeFileSync(path + pName, sObj.content);
        var outstr = '', errstr = '';
        var child = child_process.execFile('/bin/sh', ['sh']);
        child.stderr.on('data', function (chunk) { errstr += chunk; });
        child.stdout.on('data', function (chunk) { });
        runningJobPIDs[jObj.jobId] = child.pid;
        child.stdin.write('cd ' + path + '\n');
        child.stdin.write('chmod a+x ' + pName + '\n');
        child.stdin.write('./' + pName + ' > ' + oName + '\n');
        child.stdin.write('exit\n');
        
        child.on('exit', function(procRetVal, procRetSignal) {
            if (errstr != '') {
                try {
                    fs.unlinkSync(path + oName);
                    fs.unlinkSync(path + pName);
                } catch (e) { log('Could not unlink files, error was: ' + e + ' for path ' + path); }
                finalizeJob(jObj, null, errstr);
                return;
            }
            if (procRetVal == 1) {
                try {
                    fs.unlinkSync(path + oName);
                    fs.unlinkSync(path + pName);
                } catch (e) { log('Could not unlink files1, error was: ' + e + ' for path ' + path); }
                finalizeJob(jObj, null, 'Process terminated unexpectedly.');
                return;
            }
            try { 
                outstr = fs.readFileSync(path + oName, 'utf8').toString();
            } catch (e) { outstr = (procRetVal) ? 'Failure' : 'Success'; }
            if (outstr) {
                //outstr = outstr.replace(/[^\x20-\x7E]/g, ''); 
                try { outstr = outstr.trim(); } catch (e) { }
            } else {
                outstr = (procRetVal) ? 'Failure' : 'Success';
            }
            log('Output is: ' + outstr);
            try {
                fs.unlinkSync(path + oName);
                fs.unlinkSync(path + pName);
            } catch (e) { log('Could not unlink files2, error was: ' + e + ' for path ' + path); }
            finalizeJob(jObj, outstr);
        });
    } catch (e) { 
        log('Error block was (bash): ' + e);
        finalizeJob(jObj, null, e);
    }
}

function jobIsRunning(jObj) {
    return runningJobs.indexOf(jObj.jobId) > -1;
}

function runScript(sObj, jObj) {
    log('executing script (scriptId=' + sObj._id + ', jobId=' + jObj.jobId + ')');

    // get current processes and clean running jobs if they are no longer running (computer fell asleep, user caused process to stop, etc.)
    if (process.platform != 'linux' && runningJobs.length > 0) { // linux throws errors here in the meshagent for some reason
        log('updating internal job ledger; there are currently ' + runningJobs.length  + ' job(s) running');

        require('process-manager').getProcesses(function (plist) {
            if (runningJobs.length > 0) {
                runningJobs.forEach(function (jobId, idx) {
                    log('checking for running job ' + jobId + ' with PID ' + runningJobPIDs[jobId]);

                    if (typeof plist[runningJobPIDs[jobId]] === 'undefined' || typeof plist[runningJobPIDs[jobId]].cmd !== 'string') {
                        log('found orphaned job ' + jobId + '; untracking');

                        delete runningJobPIDs[jobId];
                        runningJobs.remove(runningJobs.indexOf(idx));
                    }
                });
            }
        });
    }

    if (jobIsRunning(jObj)) {
        log('WARNING: job [' + jObj.jobId + '] is already running; skipping execution');
        return;
    }

    if (null !== jObj.replaceVars) {
        log('replacing variables in script');

        Object.getOwnPropertyNames(jObj.replaceVars).forEach(function(key) {
            var val = jObj.replaceVars[key];
            sObj.content = sObj.content.replace(new RegExp('#'+key+'#', 'g'), val);
        });

        sObj.content = sObj.content.replace(new RegExp('#(.*?)#', 'g'), 'VAR_NOT_FOUND');
    }

    log('tracking job ' + jObj.jobId);
    runningJobs.push(jObj.jobId);

    switch (sObj.filetype) {
        case 'ps1':
            runPowerShell(sObj, jObj);
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
        log('WARNING: script key ' + scriptKey + ' not found in cache');

        return null;
    }

    try {
        return JSON.parse(script);
    } catch (e) {
        const message = e ? (e.message ? e.message : e.toString() ) : 'UNKNOWN';
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

function sendConsoleText(text, sessionid) {
    if (typeof text == 'object') { text = JSON.stringify(text); }
    mesh.SendCommand({ "action": "msg", "type": "console", "value": text, "sessionid": sessionid });
}

module.exports = { consoleaction : consoleaction };