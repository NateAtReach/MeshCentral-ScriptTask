/** 
* @description MeshCentral ScriptTask
* @author Ryan Blenis
* @copyright 
* @license Apache-2.0
*/

"use strict";

const jobState = require('./jobState.js');
const util = require('util');

/**
 * @typedef {import('./db.js').Job} Job
 */

/**
 * @typedef {import('./db.js').JobSchedule} JobSchedule
 */

/**
 * @typedef {import('./db.js').MeshJobSchedule} MeshJobSchedule
 */

/**
 * @typedef {import('./db.js').Script} Script
 */

module.exports.scripttask = function (parent) {
    var obj = {};
    obj.parent = parent;
    obj.meshServer = parent.parent;
    obj.db = null;
    obj.intervalTimer = null;
    obj.intervalMeshesTimer = null;
    obj.dbg = function(message) {
        try {
            parent.parent.debug('plugins', 'scripttask', message);
        } catch(e) {}
    };
    obj.VIEWS = __dirname + '/views/';
    obj.exports = [      
        'onDeviceRefreshEnd',
        'resizeContent',
        'historyData',
        'variableData',
        'malix_triggerOption'
    ];

    const parentDb = {
        GetAllType: util.promisify(obj.meshServer.db.GetAllType),
        GetAllTypeNoTypeFieldMeshFiltered: util.promisify(obj.meshServer.db.GetAllTypeNoTypeFieldMeshFiltered),
    };
    
    obj.malix_triggerOption = function(selectElem) {
        selectElem.options.add(new Option("ScriptTask - Run Script", "scripttask_runscript"));
    };

    obj.malix_triggerFields_scripttask_runscript = function() {
        
    };

    obj.resetTimers = function() {
        obj.dbg('resetting queue timers');

        obj.resetQueueTimer();
        obj.resetMeshesQueueTimer();
    };

    obj.resetQueueTimer = function() {
        clearTimeout(obj.intervalTimer);
        obj.intervalTimer = setInterval(obj.queueRun, 1 * 60 * 1000); // every minute
    };

    obj.resetMeshesQueueTimer = function() {
        clearTimeout(obj.intervalMeshesTimer);
        obj.intervalMeshesTimer = setInterval(obj.processSchedulesForMeshes, 1 * 60 * 1000); // every minute
    };
    
    obj.server_startup = function() {
        obj.dbg('starting up scripttask in response to server_startup command');

        obj.meshServer.pluginHandler.scripttask_db = require (__dirname + '/db.js').CreateDB(obj.meshServer);
        obj.db = obj.meshServer.pluginHandler.scripttask_db;
        obj.resetTimers();
    };
    
    obj.onDeviceRefreshEnd = function() {
        pluginHandler.registerPluginTab({
            tabTitle: 'ScriptTask',
            tabId: 'pluginScriptTask'
        });

        QA('pluginScriptTask', '<iframe id="pluginIframeScriptTask" style="width: 100%; height: 800px;" scrolling="no" frameBorder=0 src="/pluginadmin.ashx?pin=scripttask&user=1" />');
    };

    // may not be needed, saving for later. Can be called to resize iFrame
    obj.resizeContent = function() {
        var iFrame = document.getElementById('pluginIframeScriptTask');
        var newHeight = 800;
        var sHeight = iFrame.contentWindow.document.body.scrollHeight;

        if (sHeight > newHeight) {
            newHeight = sHeight;
        }

        if (newHeight > 1600) {
            newHeight = 1600;
        }

        iFrame.style.height = newHeight + 'px';
    };

    obj.processSchedulesForMeshes = async () => {
        obj.dbg('running processSchedulesForMeshes @ ' + Date.now());

        await obj.makeJobsFromMeshSchedules();
    };
    
    obj.queueRun = async function() {
        const onlineAgents = Object.keys(obj.meshServer.webserver.wsagents);
        obj.dbg('processing node schedule queue, there are ' + onlineAgents.length + ' agent(s) online');

        /** @type Array.<Job> */
        const pendingJobs = await obj.db.getPendingJobs(onlineAgents); //todo: chunk by 20

        if(pendingJobs.length < 1) {
            obj.dbg('no pending jobs found for online agents');

            return;
        }

        /** @type Object.<string, Script> */
        const scriptsById = {};
        for(let job of pendingJobs) {
            if(!(job.scriptId in scriptsById)) {
                scriptsById[job.scriptId] = (await obj.db.get(job.scriptId))[0];
            }

            const script = scriptsById[job.scriptId];

            obj.dbg(`executing pending job; jobId=${job._id.toString()}, scriptId=${job.scriptId}, scriptName=${job.scriptName}, node=${job.node}`);

            const foundVars = script.content.match(/#(.*?)#/g);
            const replaceVars = {};

            if (foundVars != null && foundVars.length > 0) {
                obj.dbg(`performing server-side script variable replacement; jobId=${job._id.toString()}`);

                const foundVarNames = [];

                foundVars.forEach(fv => {
                    foundVarNames.push(fv.replace(/^#+|#+$/g, ''));
                });
                
                const limiters = { 
                    scriptId: job.scriptId,
                    nodeId: job.node,
                    meshId: obj.meshServer.webserver.wsagents[job.node]['dbMeshKey'],
                    names: foundVarNames
                };

                const finvals = await obj.db.getVariables(limiters);
                const ordering = {
                    'global': 0,
                    'script': 1,
                    'mesh': 2,
                    'node': 3
                };

                finvals.sort((a, b) => {
                    return (ordering[a.scope] - ordering[b.scope])
                        || a.name.localeCompare(b.name);
                });

                finvals.forEach(fv => {
                    replaceVars[fv.name] = fv.value;
                });

                replaceVars['GBL:meshId'] = obj.meshServer.webserver.wsagents[job.node]['dbMeshKey'];
                replaceVars['GBL:nodeId'] = job.node;
            } else {
                obj.dbg(`no server-side variable replacements found; jobId=${job._id.toString()}`);
            }

            const dispatchTime = Math.floor(new Date() / 1000);
            /** @type Job */
            const jObj = { 
                action: 'plugin', 
                plugin: 'scripttask', 
                pluginaction: 'triggerJob',
                jobId: job._id,
                scriptId: job.scriptId,
                replaceVars: replaceVars,
                scriptHash: script.contentHash,
                dispatchTime: dispatchTime,
                state: jobState.DISPATCHED
            };

            const dispatchToNode = () => {
                obj.dbg(`dispatching job ${job._id.toString()} to ${job.node}`);

                obj.meshServer.webserver.wsagents[job.node].send(JSON.stringify(jObj));
            };
            
            try {
                obj.dbg(`updating job metadata for job ${job._id.toString()}; set dispatchTime=${dispatchTime}, state: ${jobState.DISPATCHED}`);

                await obj.db.update(
                    job._id,
                    {
                        dispatchTime: dispatchTime,
                        state: jobState.DISPATCHED,
                    }
                );
            } catch (e) {
                obj.dbg(`ERROR: failed to update job state; reason=${e?.message || e?.toString() || 'UNKNOWN'}`);
            } finally {
                dispatchToNode();
            }
        }

        obj.makeJobsFromSchedules();
        obj.cleanHistory();
    };
    
    obj.cleanHistory = function() {
        if (Math.round(Math.random() * 100) == 99) {
            //obj.debug('Plugin', 'ScriptTask', 'Running history cleanup');
            obj.db.deleteOldHistory();
        }
    };
    
    obj.downloadFile = function(req, res, user) {
        var id = req.query.dl;
        obj.db.get(id)
        .then(found => {
            if (found.length != 1) {
                res.sendStatus(401); return;
            }

            var file = found[0];
            res.setHeader('Content-disposition', 'attachment; filename=' + file.name);
            res.setHeader('Content-type', 'text/plain');

            res.send(file.content);
        });
    };
    
    obj.updateFrontEnd = async function(ids){
        if (ids.scriptId != null) {
            //get script history request

            var scriptHistory = null;
            obj.db.getJobScriptHistory(ids.scriptId)
                .then((/** @type Array.<Job> */ sh) => {
                    scriptHistory = sh;
                    return obj.db.getJobSchedulesForScript(ids.scriptId);
                })
                .then((/** @type Array.<JobSchedule> */ scriptSchedule) => {
                    var targets = ['*', 'server-users'];
                    obj.meshServer.DispatchEvent(
                        targets,
                        obj,
                        {
                            nolog: true,
                            action: 'plugin',
                            plugin: 'scripttask',
                            pluginaction: 'historyData',
                            scriptId: ids.scriptId,
                            nodeId: null,
                            scriptHistory: scriptHistory,
                            nodeHistory: null,
                            scriptSchedule: scriptSchedule
                        });
                });
        }

        if (ids.nodeId != null) {
            var nodeHistory = null;
            obj.db
                .getJobNodeHistory(ids.nodeId)
                .then((/** @type Array.<Job> */ nh) => {
                    nodeHistory = nh;
                    return obj.db.getJobSchedulesForNode(ids.nodeId);
                })
                .then((/** @type Array.<JobSchedule> */ nodeSchedule) => {
                    var targets = ['*', 'server-users'];
                    obj.meshServer.DispatchEvent(
                        targets,
                        obj,
                        {
                            nolog: true, 
                            action: 'plugin', 
                            plugin: 'scripttask', 
                            pluginaction: 'historyData', 
                            scriptId: null, 
                            nodeId: ids.nodeId, 
                            scriptHistory: null, 
                            nodeHistory: nodeHistory, 
                            nodeSchedule: nodeSchedule
                        }
                    );
                });
        }

        if (ids.tree === true) {
            obj.db
                .getScriptTree()
                .then((tree) => {
                    var targets = ['*', 'server-users'];
                    obj.meshServer.DispatchEvent(targets, obj, { nolog: true, action: 'plugin', plugin: 'scripttask', pluginaction: 'newScriptTree', tree: tree });
                });
        }

        if (ids.variables === true) {
            obj.db.getVariables()
            .then((vars) => {
                var targets = ['*', 'server-users'];
                obj.meshServer.DispatchEvent(targets, obj, { nolog: true, action: 'plugin', plugin: 'scripttask', pluginaction: 'variableData', vars: vars });
            });
        }
    };
    
    obj.handleAdminReq = function(req, res, user) {
        if ((user.siteadmin & 0xFFFFFFFF) == 1 && req.query.admin == 1) 
        {
            // admin wants admin, grant
            var vars = {};
            res.render(obj.VIEWS + 'admin', vars);
            return;
        } else if (req.query.admin == 1 && (user.siteadmin & 0xFFFFFFFF) == 0) {
            // regular user wants admin
            res.sendStatus(401); 
            return;
        } else if (req.query.user == 1) { 
            // regular user wants regular access, grant
            if (req.query.dl != null) return obj.downloadFile(req, res, user);
            var vars = {};
            
            if (req.query.edit == 1) { // edit script
                if (req.query.id == null) return res.sendStatus(401); 
                obj.db.get(req.query.id)
                .then((scripts) => {
                    if (scripts[0].filetype == 'proc') {
                        vars.procData = JSON.stringify(scripts[0]);
                        res.render(obj.VIEWS + 'procedit', vars);
                    } else {
                        vars.scriptData = JSON.stringify(scripts[0]);
                        res.render(obj.VIEWS + 'scriptedit', vars);
                    }
                });
                return;
            } else if (req.query.schedule == 1) {
                var vars = {};
                res.render(obj.VIEWS + 'schedule', vars);
                return;
            }
            // default user view (tree)
            vars.scriptTree = 'null';
            obj.db.getScriptTree()
            .then(tree => {
              vars.scriptTree = JSON.stringify(tree);
              res.render(obj.VIEWS + 'user', vars);
            });
            return;
        } else if (req.query.include == 1) {
            switch (req.query.path.split('/').pop().split('.').pop()) {
                case 'css':     res.contentType('text/css'); break;
                case 'js':      res.contentType('text/javascript'); break;
            }
            res.sendFile(__dirname + '/includes/' + req.query.path); // don't freak out. Express covers any path issues.
            return;
        }
        res.sendStatus(401); 
        return;
    };
    
    obj.historyData = function (message) {
        if (typeof pluginHandler.scripttask.loadHistory == 'function') {
            pluginHandler.scripttask.loadHistory(message);
        }

        if (typeof pluginHandler.scripttask.loadSchedule == 'function') {
            pluginHandler.scripttask.loadSchedule(message);
        }
    };
    
    obj.variableData = function (message) {
        if (typeof pluginHandler.scripttask.loadVariables == 'function') pluginHandler.scripttask.loadVariables(message);
    };
    
    /**
     * 
     * @param {JobSchedule|MeshJobSchedule} s 
     * @returns {number|null}
     */
    obj.determineNextJobTime = function(s) {
        var nextTime = null;
        var nowTime = Math.floor(new Date() / 1000);
        
        // special case: we've reached the end of our run
        if (s.endAt !== null && s.endAt <= nowTime) {
            return nextTime;
        }

        switch (s.recur) {
            case 'once':
                if (s.nextRun == null) {
                    nextTime = s.startAt;
                }
                else {
                    nextTime = null;
                }
            break;
            case 'minutes':
                /*var lRun = s.nextRun || nowTime;
                if (lRun == null) lRun = nowTime;
                nextTime = lRun + (s.interval * 60);
                if (s.startAt > nextTime) nextTime = s.startAt;*/
                if (s.nextRun == null) { // hasn't run yet, set to start time
                    nextTime = s.startAt;
                    break;
                }
                nextTime = s.nextRun + (s.interval * 60);
                // this prevents "catch-up" tasks being scheduled if an endpoint is offline for a long period of time
                // e.g. always make sure the next scheduled time is relevant to the scheduled interval, but in the future
                if (nextTime < nowTime) {
                    // initially I was worried about this causing event loop lockups
                    // if there was a long enough time gap. Testing over 50 years of backlog for a 3 min interval
                    // still ran under a fraction of a second. Safe to say this approach is safe! (~8.5 million times)
                    while (nextTime < nowTime) {
                        nextTime = nextTime + (s.interval * 60);
                    }
                }
                if (s.startAt > nextTime) nextTime = s.startAt;
            break;
            case 'hourly':
                if (s.nextRun == null) { // hasn't run yet, set to start time
                    nextTime = s.startAt;
                    break;
                }
                nextTime = s.nextRun + (s.interval * 60 * 60);
                if (nextTime < nowTime) {
                    while (nextTime < nowTime) {
                        nextTime = nextTime + (s.interval * 60 * 60);
                    }
                }
                if (s.startAt > nextTime) nextTime = s.startAt;
            break;
            case 'daily':
                if (s.nextRun == null) { // hasn't run yet, set to start time
                    nextTime = s.startAt;
                    break;
                }
                nextTime = s.nextRun + (s.interval * 60 * 60 * 24);
                if (nextTime < nowTime) {
                    while (nextTime < nowTime) {
                        nextTime = nextTime + (s.interval * 60 * 60 * 24);
                    }
                }
                if (s.startAt > nextTime) nextTime = s.startAt;
            break;
            case 'weekly':
                var tempDate = new Date();
                var nowDate = new Date(tempDate.getFullYear(), tempDate.getMonth(), tempDate.getDate());
                
                if (s.daysOfWeek.length == 0) {
                    nextTime = null;
                    break;
                }
                s.daysOfWeek = s.daysOfWeek.map(el => Number(el));
                var baseTime = s.startAt;
                //console.log('dow is ', s.daysOfWeek);
                var lastDayOfWeek = Math.max(...s.daysOfWeek);
                var startX = 0;
                //console.log('ldow is ', lastDayOfWeek);
                if (s.nextRun != null) {
                    baseTime = s.nextRun;
                    //console.log('basetime 2: ', baseTime);
                    if (nowDate.getDay() == lastDayOfWeek) {
                        baseTime = baseTime + ( s.interval * 604800 ) - (lastDayOfWeek * 86400);
                        //console.log('basetime 3: ', baseTime);
                    }
                    startX = 0;
                } else if (s.startAt < nowTime) {
                    baseTime = Math.floor(nowDate.getTime() / 1000);
                    //console.log('basetime 4: ', baseTime);
                }
                //console.log('startX is: ', startX);
                //var secondsFromMidnight = nowTimeDate.getSeconds() + (nowTimeDate.getMinutes() * 60) + (nowTimeDate.getHours() * 60 * 60);
                //console.log('seconds from midnight: ', secondsFromMidnight);
                //var dBaseTime = new Date(0); dBaseTime.setUTCSeconds(baseTime);
                //var dMidnight = new Date(dBaseTime.getFullYear(), dBaseTime.getMonth(), dBaseTime.getDate());
                //baseTime = Math.floor(dMidnight.getTime() / 1000);
                for (var x = startX; x <= 7; x++){
                    var checkDate = baseTime + (86400 * x);
                    var d = new Date(0); d.setUTCSeconds(checkDate);
                    var dm = new Date(d.getFullYear(), d.getMonth(), d.getDate());
                    
                    //console.log('testing date: ', dm.toLocaleString()); // dMidnight.toLocaleString());
                    //console.log('if break check :', (s.daysOfWeek.indexOf(d.getDay()) !== -1 && checkDate >= nowTime));
                    //console.log('checkDate vs nowTime: ', (checkDate - nowTime), ' if positive, nowTime is less than checkDate');
                    if (s.nextRun == null && s.daysOfWeek.indexOf(dm.getDay()) !== -1 && dm.getTime() >= nowDate.getTime()) break;
                    if (s.daysOfWeek.indexOf(dm.getDay()) !== -1 && dm.getTime() > nowDate.getTime()) break;
                    //if (s.daysOfWeek.indexOf(d.getDay()) !== -1 && Math.floor(d.getTime() / 1000) >= nowTime) break;
                }
                var sa = new Date(0); sa.setUTCSeconds(s.startAt);
                var sad = new Date(sa.getFullYear(), sa.getMonth(), sa.getDate());
                var diff = (sa.getTime() - sad.getTime()) / 1000;
                nextTime = Math.floor(dm.getTime() / 1000) + diff;
                //console.log('next schedule is ' + d.toLocaleString());
            break;
            default:
                nextTime = null;
            break;
        }
        
        if (s.endAt != null && nextTime > s.endAt) nextTime = null; // if the next time reaches the bound of the endAt time, nullify
        
        return nextTime;
    };

    obj.makeJobsFromMeshSchedules = async function(scheduleId) {
        obj.dbg('makeJobsFromMeshSchedules');

        /** @type Array.<MeshJobSchedule> */
        const schedules = await obj.db.getSchedulesDueForJob(scheduleId, 'meshJobSchedule');

        obj.dbg('found ' + schedules.length + ' schedules to process');

        if(schedules.length < 1) {
            return;
        }

        for(const schedule of schedules) {
            try {
                const scheduleId = schedule._id.toString();

                obj.dbg(`processing mesh job schedule (scheduleId=${scheduleId})`);

                var nextJobTime = obj.determineNextJobTime(schedule);

                obj.dbg(`schedule ${scheduleId} nextJobTime is ${nextJobTime}`);

                if (nextJobTime === null) {
                    obj.dbg(`job schedule has ended, removing schedule from database (scheduleId=${scheduleId})`);

                    obj.db.removeJobSchedule(schedule._id);
                } else {
                    /** @type {Array.<Script>} */
                    const scripts = await obj.db.get(schedule.scriptId);

                    if(scripts.length != 1) {
                        obj.dbg(`ERROR: failed to get script ${s.scriptId}; received ${script.length} record(s) but exactly 1 was expected`);
                    }

                    const script = scripts[0];

                    const nodesInMesh = await parentDb.GetAllTypeNoTypeFieldMeshFiltered(
                        [ schedule.mesh ],
                        undefined, //extrasids
                        "", //domain
                        "node",
                        null, //id
                        0, //skip
                        2000000 //limit
                    );

                    obj.dbg(`processing schedule (id=${scheduleId}) on mesh ${schedule.mesh} with ${nodesInMesh.length} node(s)`);
                    
                    for(const node of nodesInMesh) {
                        const nodeId = node._id.toString();

                        const incompleteJobs = await obj.db.getIncompleteJobsForSchedule(schedule._id, nodeId);

                        if(incompleteJobs.length > 0) {
                            obj.dbg(`incomplete job found for node ${nodeId}; skipping`);

                            continue;
                        }

                        obj.dbg(`scheduled task (scheduleId=${scheduleId}, scriptName=${script.name}) on node ${nodeId}`);

                        await obj.db.addJob({
                            scriptId: schedule.scriptId,
                            scriptName: script.name,
                            node: nodeId,
                            runBy: schedule.scheduledBy,
                            dontQueueUntil: nextJobTime,
                            jobSchedule: schedule._id,
                            state: jobState.SCHEDULED,
                        });

                        obj.updateFrontEnd({
                            scriptId: schedule.scriptId,
                            nodeId: nodeId
                        });
                    }
                }
            } catch(e) {
                obj.dbg(`ERROR: makeJobsFromMeshSchedules failed; reason=${e?.message || e?.toString() || 'UNKNOWN'}`)
            } finally {
                await obj.db.update(schedule._id, { nextRun: nextJobTime });
            }
        }
    };

    obj.makeJobsFromSchedules = function(scheduleId) {
        //obj.debug('ScriptTask', 'makeJobsFromSchedules starting');
        return obj.db.getSchedulesDueForJob(scheduleId)
            .then((/** @type Array.<JobSchedule> */ schedules) => {
                //obj.debug('ScriptTask', 'Found ' + schedules.length + ' schedules to process. Current time is: ' + Math.floor(new Date() / 1000));

                if (schedules.length) {
                    schedules.forEach(s => {
                        var nextJobTime = obj.determineNextJobTime(s);

                        var nextJobScheduled = false;

                        if (nextJobTime === null) {
                            //obj.debug('ScriptTask', 'Removing Job Schedule for', JSON.stringify(s));
                            obj.db.removeJobSchedule(s._id);
                        } else {
                            //obj.debug('ScriptTask', 'Scheduling Job for', JSON.stringify(s));
                            obj.db.get(s.scriptId)
                                .then((/** @type Array.<Script> */ scripts) => {
                                    // if a script is scheduled to run, but a previous run hasn't completed, 
                                    // don't schedule another job for the same (device probably offline).
                                    // results in the minimum jobs running once an agent comes back online.
                                    return obj.db.getIncompleteJobsForSchedule(s._id)
                                        .then((jobs) => {
                                            if (jobs.length > 0) {
                                                /* obj.debug('Plugin', 'ScriptTask', 'Skipping job creation'); */
                                                return Promise.resolve();
                                            } else {
                                                /* obj.debug('Plugin', 'ScriptTask', 'Creating new job'); */
                                                nextJobScheduled = true;

                                                return obj.db.addJob({
                                                    scriptId: s.scriptId,
                                                    scriptName: scripts[0].name,
                                                    node: s.node,
                                                    runBy: s.scheduledBy,
                                                    dontQueueUntil: nextJobTime,
                                                    jobSchedule: s._id,
                                                    state: jobState.SCHEDULED,
                                                });
                                            }
                                        });
                                })
                                .then(() => {
                                    if (nextJobScheduled) {
                                        /* obj.debug('Plugin', 'ScriptTask', 'Updating nextRun time'); */
                                        return obj.db.update(s._id, { nextRun: nextJobTime });
                                    } else {
                                        /* obj.debug('Plugin', 'ScriptTask', 'NOT updating nextRun time'); */
                                        return Promise.resolve();
                                    }
                                })
                                .then(() => {
                                    obj.updateFrontEnd({
                                        scriptId: s.scriptId,
                                        nodeId: s.node
                                    });
                                })
                                .catch((e) => { console.log('PLUGIN: ScriptTask: Error managing job schedules: ', e); });
                        }
                    });
                }
            });
    };
    
    obj.deleteElement = function (command) {
        var delObj = null;
        obj.db.get(command.id)
            .then((found) => {
                var file = found[0];
                delObj = {...{}, ...found[0]};
                return file;
            })
            .then((file) => {
                if (file.type == 'folder') {
                    //@TODO delete schedules for scripts within folders
                    return obj.db.deleteByPath(file.path);
                } else if (file.type == 'script') {
                    return obj.db.deleteSchedulesForScript(file._id);
                } else if (file.type == 'jobSchedule') {
                    return obj.db.deletePendingJobsForSchedule(file._id);
                }
            })
            .then(() => {
                return obj.db.delete(command.id);
            })
            .then(() => {
                var updateObj = { tree: true };

                if (delObj.type == 'jobSchedule') {
                    updateObj.scriptId = delObj.scriptId;
                    updateObj.nodeId = delObj.node;
                }

                return obj.updateFrontEnd( updateObj );
            })
            .catch(e => { console.log('PLUGIN: ScriptTask: Error deleting ', e.stack); });
    };
    
    obj.serveraction = function(command, myparent, grandparent) {
        switch (command.pluginaction) {
            case 'updateJobState':
                obj.db.update(command.jobId, { state: command.newState })
                    .then(() => {
                        obj.updateFrontEnd({
                            scriptId: command.scriptId,
                            nodeId: myparent.dbNodeKey
                        });
                    });

                break;
            case 'addScript':
                obj.db.addScript(command.name, command.content, command.path, command.filetype)
                .then(() => {
                    obj.updateFrontEnd( { tree: true } );
                });            
            break;
            case 'new':
                var parent_path = '';
                var new_path = '';
                obj.db.get(command.parent_id)
                .then(found => {
                  if (found.length > 0) {
                      var file = found[0];
                      parent_path = file.path;
                  } else {
                      parent_path = 'Shared';
                  }
                })
                .then(() => {
                    obj.db.addScript(command.name, '', parent_path, command.filetype)
                })
                .then(() => {
                    obj.updateFrontEnd( { tree: true } );
                });
            break;
            case 'rename':
              obj.db.get(command.id)
              .then((docs) => {
                  var doc = docs[0];
                  if (doc.type == 'folder') {
                      console.log('old', doc.path, 'new', doc.path.replace(doc.path, command.name));
                      return obj.db.update(command.id, { path: doc.path.replace(doc.name, command.name) })
                      .then(() => { // update sub-items
                          return obj.db.getByPath(doc.path)
                      })
                      .then((found) => {
                          if (found.length > 0) {
                            var proms = [];
                            found.forEach(f => {
                              proms.push(obj.db.update(f._id, { path: doc.path.replace(doc.name, command.name) } ));
                            })
                            return Promise.all(proms);
                          }
                      })
                  } else {
                      return Promise.resolve();
                  }
              })
              .then(() => {
                  obj.db.update(command.id, { name: command.name })
              })
              .then(() => {
                  return obj.db.updateScriptJobName(command.id, command.name);
              })
              .then(() => {
                  obj.updateFrontEnd( { scriptId: command.id, nodeId: command.currentNodeId, tree: true } );
              });
            break;
            case 'move':
              var toPath = null, fromPath = null, parentType = null;
              obj.db.get(command.to)
              .then(found => { // get target data
                  if (found.length > 0) {
                    var file = found[0];
                    toPath = file.path;
                  } else throw Error('Target destination not found');
              })
              .then(() => { // get item to be moved
                return obj.db.get(command.id);
              })
              .then((found) => { // set item to new location
                  var file = found[0];
                  if (file.type == 'folder') {
                    fromPath = file.path;
                    toPath += '/' + file.name;
                    parentType = 'folder';
                    if (file.name == 'Shared' && file.path == 'Shared') throw Error('Cannot move top level directory: Shared');
                  }
                  return obj.db.update(command.id, { path: toPath } );
              })
              .then(() => { // update sub-items
                  return obj.db.getByPath(fromPath)
              })
              .then((found) => {
                  if (found.length > 0) {
                    var proms = [];
                    found.forEach(f => {
                      proms.push(obj.db.update(f._id, { path: toPath } ));
                    })
                    return Promise.all(proms);
                  }
              })
              .then(() => {
                return obj.updateFrontEnd( { tree: true } );
              })
              .catch(e => { console.log('PLUGIN: ScriptTask: Error moving ', e.stack); });
            break;
            case 'newFolder':
              var parent_path = '';
              var new_path = '';
              
              obj.db.get(command.parent_id)
              .then(found => {
                if (found.length > 0) {
                    var file = found[0];
                    parent_path = file.path;
                } else {
                    parent_path = 'Shared';
                }
              })
              .then(() => {
                new_path = parent_path + '/' + command.name;
              })
              .then(() => {
                  return obj.db.addFolder(command.name, new_path);
              })
              .then(() => {
                return obj.updateFrontEnd( { tree: true } );
              })
              .catch(e => { console.log('PLUGIN: ScriptTask: Error creating new folder ', e.stack); });
            break;
            case 'delete':
                obj.deleteElement(command);

                break;
            case 'addScheduledMeshJob':
                obj.dbg(`addScheduledMeshJob: ${JSON.stringify(command)}`);

                var sj = command.schedule;
                
                /** @type MeshJobSchedule */
                var sched = {
                    scriptId: command.scriptId, 
                    mesh: null, 
                    scheduledBy: myparent.user.name,
                    recur: sj.recur,
                    interval: sj.interval,
                    daysOfWeek: sj.dayVals,
                    startAt: sj.startAt,
                    endAt: sj.endAt,
                    lastRun: null,
                    nextRun: null,
                    type: "meshJobSchedule"
                };

                var sel = command.meshes;
                var proms = [];
                if (Array.isArray(sel)) {
                  sel.forEach((s) => {
                    var sObj = {...sched, ...{
                        mesh: s
                    }};

                    obj.dbg(`adding mesh job schedule: ${JSON.stringify(sObj)}`);

                    proms.push((async () => {
                        try {
                            await obj.db.addMeshJobSchedule( sObj );
                        } catch(e) {
                            obj.dbg(`ERROR: ${e?.message || e?.toString() || 'UNKNOWN'}`);
                        }
                    })());
                  });
                } else {
                    obj.dbg(`WARNING: obj.meshes was of unexpected type ${typeof sel} (isArray=${Array.isArray(sel)}). An array is required.`);
                }

                Promise.all(proms)
                    .then(() => {
                        obj.makeJobsFromMeshSchedules();

                        return Promise.resolve();
                    })
                    .catch(e => { console.log('PLUGIN: ScriptTask: Error adding schedules. The error was: ', e); });

                break;
            case 'addScheduledJob':
                /* { 
                    scriptId: scriptId, 
                    node: s, 
                    scheduledBy: myparent.user.name,
                    recur: command.recur, // [once, minutes, hourly, daily, weekly, monthly]
                    interval: x,
                    daysOfWeek: x, // only used for weekly recur val
                    // onTheXDay: x, // only used for monthly
                    startAt: x,
                    endAt: x,
                    runCountLimit: x,
                    lastRun: x,
                    nextRun: x,
                    type: "scheduledJob"
                } */
                var sj = command.schedule;
                
                /** @type JobSchedule */
                var sched = {
                    scriptId: command.scriptId, 
                    node: null, 
                    scheduledBy: myparent.user.name,
                    recur: sj.recur,
                    interval: sj.interval,
                    daysOfWeek: sj.dayVals,
                    startAt: sj.startAt,
                    endAt: sj.endAt,
                    lastRun: null,
                    nextRun: null,
                    type: "jobSchedule"
                };
                var sel = command.nodes;
                var proms = [];
                if (Array.isArray(sel)) {
                  sel.forEach((s) => {
                    var sObj = {...sched, ...{
                        node: s
                    }};
                    proms.push(obj.db.addJobSchedule( sObj ));
                  });
                } else { test.push(sObj);
                    proms.push(obj.db.addJobSchedule( sObj ));
                }

                Promise.all(proms)
                    .then(() => {
                        obj.makeJobsFromSchedules();
                        return Promise.resolve();
                    })
                    .catch(e => { console.log('PLUGIN: ScriptTask: Error adding schedules. The error was: ', e); });

                break;
            case 'runScript':
              var scriptId = command.scriptId;
              var sel = command.nodes;
              var proms = [];
              if (Array.isArray(sel)) {
                sel.forEach((s) => {
                  proms.push(
                    obj.db.addJob({ 
                        scriptId: scriptId, 
                        node: s, 
                        runBy: myparent.user.name,
                        state: jobState.SCHEDULED,
                    })
                );
                });
              } else {
                proms.push(
                    obj.db.addJob({
                        scriptId: scriptId,
                        node: sel,
                        runBy: myparent.user.name,
                        state: jobState.SCHEDULED,
                    })
                );
              }

              Promise.all(proms)
                .then(() => {
                    return obj.db.get(scriptId);
                })
                .then(scripts => {
                    return obj.db.updateScriptJobName(scriptId, scripts[0].name);
                })
                .then(() => {
                    obj.resetTimers();
                    obj.queueRun();
                    obj.updateFrontEnd({ 
                        scriptId: scriptId, 
                        nodeId: command.currentNodeId
                    });
                });
            break;
            case 'getScript':
                //obj.debug('ScriptTask', 'getScript Triggered', JSON.stringify(command));
                obj.db.get(command.scriptId)
                .then(script => {
                    myparent.send(JSON.stringify({ 
                        action: 'plugin',
                        plugin: 'scripttask',
                        pluginaction: 'cacheScript',
                        nodeid: myparent.dbNodeKey,
                        rights: true,
                        sessionid: true,
                        script: script[0]
                    }));
                });
            break;
            case 'jobComplete':
                //obj.debug('ScriptTask', 'jobComplete Triggered', JSON.stringify(command));
                var jobId = command.jobId, retVal = command.retVal, errVal = command.errVal, dispatchTime = command.dispatchTime;
                var completeTime = Math.floor(new Date() / 1000);

                obj.db.update(
                    jobId,
                    {
                        completeTime: completeTime,
                        returnVal: retVal,
                        errorVal: errVal,
                        dispatchTime: dispatchTime,
                        state: jobState.COMPLETE,
                    }
                ).then(() => {
                    return obj.db.get(jobId)
                        .then(jobs => {
                            return Promise.resolve(jobs[0].jobSchedule);
                        })
                        .then(sId => {
                            if (sId == null) {
                                return Promise.resolve();
                            }

                            return obj.db.update(
                                sId, {
                                    lastRun: completeTime
                                })
                                .then(() => {
                                    obj.makeJobsFromSchedules(sId);
                                });
                        });
                })
                .then(() => {
                    obj.updateFrontEnd({ 
                        scriptId: command.scriptId, 
                        nodeId: myparent.dbNodeKey
                    });
                })
                .catch(e => { console.log('PLUGIN: ScriptTask: Failed to complete job. ', e); });

                break;
            case 'loadNodeHistory':
                obj.updateFrontEnd( { nodeId: command.nodeId } );

                break;
            case 'loadScriptHistory':
                obj.updateFrontEnd( { scriptId: command.scriptId } );

                break;
            case 'editScript':
                obj.db.update(command.scriptId, { type: command.scriptType, name: command.scriptName, content: command.scriptContent })
                    .then(() => {
                        obj.updateFrontEnd( { scriptId: command.scriptId, tree: true } );
                    });

                break;
            case 'clearAllPendingJobs':
                obj.db.deletePendingJobsForNode(myparent.dbNodeKey);
            break;
            case 'loadVariables':
                obj.updateFrontEnd( { variables: true } );
            break;
            case 'newVar':
                obj.db.addVariable(command.name, command.scope, command.scopeTarget, command.value)
                .then(() => {
                    obj.updateFrontEnd( { variables: true } );
                })
            break;
            case 'editVar':
                obj.db.update(command.id, { 
                    name: command.name, 
                    scope: command.scope, 
                    scopeTarget: command.scopeTarget,
                    value: command.value
                })
                .then(() => {
                    obj.updateFrontEnd( { variables: true } );
                })
            break;
            case 'deleteVar':
                obj.db.delete(command.id)
                .then(() => {
                    obj.updateFrontEnd( { variables: true } );
                })
            break;
            default:
                console.log('PLUGIN: ScriptTask: unknown action');
            break;
        }
    };
    
    return obj;
}