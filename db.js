/** 
* @description MeshCentral-ScriptTask database module
* @author Ryan Blenis
* @copyright Ryan Blenis 2019
* @license Apache-2.0
*/

"use strict";

/**
 * A job execution instruction
 * @typedef {Object} Job
 * @property {ObjectID} _id
 * @property {'job'} type - type of record (for MongoDB discrimination)
 * @property {number} queueTime - UTC millis when job was queued
 * @property {number} dontQueueUntil - UTC millis of when job is eligble to be queued
 * @property {number} dispatchTime - UTC millis when the job was dispatched to client
 * @property {number} completeTime - UTC millis when the job was completed
 * @property {string} node - mesh node ID the job is to run on
 * @property {string} scriptId - id of the script to execute
 * @property {string} scriptName - name of the script to run
 * @property {unknown|null} replaceVars - variable replacement collection
 * @property {string|null} returnVal - result of the job (i.e. script stdout once complete)
 * @property {string|null} errorVal - error output of the job (i.e. script stderr once complete)
 * @property {unknown} returnAct - unknown purpose
 * @property {string} runBy - username that invoked the job
 * @property {ObjectID} jobSchedule - reference to job schedule
 * @property {jobState} state - state of the job
 */

/**
 * A job execution schedule
 * @typedef {Object} JobSchedule
 * @property {ObjectID} _id - mongo ID
 * @property {'jobSchedule'} type - type discriminator
 * @property {string} scriptId - id of the script
 * @property {string} node - node the script is scheduled on
 * @property {string} scheduledBy - who made the schedule
 * @property {'once'|'minutes'|'hourly'|'daily'|'weekly'} recur - recurrence basis
 * @property {number} interval - recurrence interval
 * @property {unknown} daysOfWeek - which days of the week to run on
 * @property {number} startAt - UTC millis of when the schedule begins
 * @property {number} endAt - UTC millis of when the schedule ends
 * @property {number} lastRun - UTC millis of the last execution of this schedule
 * @property {number} nextRun - UTC millis of the next time to run the schedule
 * @property {string} target - scheduling tartget (e.g. "Jane Doe's Laptop" or "Mesh: IT-Test")
 */

/**
 * A mesh-based job execution schedule
 * @typedef {Object} MeshJobSchedule
 * @property {ObjectID} _id - mongo ID
 * @property {'meshJobSchedule'} type - type discriminator
 * @property {string} scriptId - id of the script
 * @property {string} mesh - mesh the script is scheduled on
 * @property {string} scheduledBy - who made the schedule
 * @property {'once'|'minutes'|'hourly'|'daily'|'weekly'} recur - recurrence basis
 * @property {number} interval - recurrence interval
 * @property {unknown} daysOfWeek - which days of the week to run on
 * @property {number} startAt - UTC millis of when the schedule begins
 * @property {number} endAt - UTC millis of when the schedule ends
 * @property {number} lastRun - UTC millis of the last execution of this schedule
 * @property {number} nextRun - UTC millis of the next time to run the schedule
 * @property {string} target - scheduling tartget (e.g. "Jane Doe's Laptop" or "Mesh: IT-Test")
 */

/**
 * A script
 * @typedef {Object} Script
 * @property {ObjectID} _id - mongo ID
 * @property {'script'} type - type discriminator
 * @property {string} path - virtual folder path
 * @property {string} name - script name
 * @property {string} content - script contents
 * @property {string} contentHash - script hash
 * @property {'ps1'|'bat'|'bash'} filetype - type of script
 */

const jobState = require('./jobState');

var Datastore = null;
var formatId = null;

module.exports.CreateDB = function(meshserver) {
    var obj = {};
    var NEMongo = require(__dirname + '/nemongo.js');
    obj.dbVersion = 1;
    
    obj.initFunctions = function () {
        obj.updateDBVersion = function(new_version) {
          return obj.scriptFile.updateOne({type: "db_version"}, { $set: {version: new_version} }, {upsert: true});
        };
        
        obj.getDBVersion = function() {
            return new Promise(function(resolve, reject) {
                obj.scriptFile.find( { type: "db_version" } ).project( { _id: 0, version: 1 } ).toArray(function(err, vers){
                    if (vers.length == 0) resolve(1);
                    else resolve(vers[0]['version']);
                });
            });
        };

        obj.addScript = function(name, content, path, filetype) {
            if (path == null) path = "Shared"
            if (filetype == 'bash') content = content.split('\r\n').join('\n').split('\r').join('\n');
            var sObj = { 
                type: 'script',
                path: path,
                name: name,
                content: content,
                contentHash: require('crypto').createHash('sha384').update(content).digest('hex'),
                filetype: filetype
            };
            return obj.scriptFile.insertOne(sObj);
        };
        
        obj.addFolder = function(name, path) {
            var sObj = {
                type: 'folder',
                path: path,
                name: name
            };
            return obj.scriptFile.insertOne(sObj);
        };
        
        obj.getScriptTree = function() {
            return obj.scriptFile.find(
                { type:
                    { $in: [ 'script', 'folder' ] }
                }
            ).sort(
                { path: 1, type: 1, name: 1 }
            ).project(
                { name: 1, path: 1, type: 1, filetype: 1 }
            ).toArray();
        };
        
        obj.update = function(id, args) {
            id = formatId(id);
            if (args.type == 'script' && args.content !== null) { 
                if (args.filetype == 'bash') {
                    args.content = args.content = split('\r\n').join('\n').split('\r').join('\n');
                }
                args.contentHash = require('crypto').createHash('sha384').update(args.content).digest('hex');
            }
            return obj.scriptFile.updateOne( { _id: id }, { $set: args } );
        };

        obj.delete = function(id) {
            id = formatId(id);
            return obj.scriptFile.deleteOne( { _id: id } );
        };

        obj.deleteByPath = function(path) {
          return obj.scriptFile.deleteMany( { path: path, type: { $in: ['script', 'folder'] } } );
        };

        obj.deleteSchedulesForScript = function(id) {
            id = formatId(id);
            return obj.scriptFile.deleteMany( { type: 'jobSchedule', scriptId: id } );
        };

        obj.getByPath = function(path) {
          return obj.scriptFile.find( { type: { $in: [ 'script', 'folder' ] }, path: path }).toArray();
        };

        obj.get = function(id) {
            if (id == null || id == 'null') return new Promise(function(resolve, reject) { resolve([]); });
            id = formatId(id);
            return obj.scriptFile.find( { _id: id } ).toArray();
        };

        obj.addJob = function(passedObj) {
          var nowTime = Math.floor(new Date() / 1000);
          var defaultObj = { 
              type: 'job',
              queueTime: nowTime,
              dontQueueUntil: nowTime,
              dispatchTime: null,
              completeTime: null,
              node: null,
              scriptId: null,
              scriptName: null, // in case the original reference is deleted in the future
              replaceVars: null,
              returnVal: null,
              errorVal: null,
              returnAct: null,
              runBy: null,
              jobSchedule: null,
              state: jobState.CREATED,
          };
          var jObj = {...defaultObj, ...passedObj};
          
          if (jObj.node == null || jObj.scriptId == null) { console.log('PLUGIN: SciptTask: Could not add job'); return false; }
          
          return obj.scriptFile.insertOne(jObj);
        };

        obj.addMeshJobSchedule = function(schedObj) {
            schedObj.type = 'meshJobSchedule';

            if(schedObj.mesh == null) {
                throw new Error(`failed to add mesh job schedule: property 'mesh' is nullish`);
            }

            if(schedObj.scriptId == null) {
                throw new Error(`failed to add mesh job schedule: property 'scriptId' is nullish`);
            }

            return obj.scriptFile.insertOne(schedObj);
        };

        obj.addJobSchedule = function(schedObj) {
            schedObj.type = 'jobSchedule';

            if (schedObj.node == null || schedObj.scriptId == null) {
                console.log('PLUGIN: SciptTask: Could not add job schedule');
                
                return false;
            }

            return obj.scriptFile.insertOne(schedObj);
        };

        obj.removeJobSchedule = function (id) {
            return obj.delete(id);
        };

        /**
         * Returns JobSchedule objects which are overdue (nextRun <= now) and for which the current
         * time is within the execution window (endAt <= now).
         * 
         * If scheduleId is provided, limits results to that specific schedule.
         * 
         * @param {string|undefined} scheduleId - mongo DB _id for schedule
         * @param {'jobSchedule'|'meshJobSchedule'|undefined} - type of schedule to search. Default: jobSchedule
         * @returns {Promise.<Array.<JobSchedule>>}
         */
        obj.getSchedulesDueForJob = function(scheduleId, type) {
            var nowTime = Math.floor(new Date() / 1000);
            var scheduleIdLimiter = {};
            if (scheduleId != null) {
                scheduleIdLimiter._id = scheduleId;
            }

            return obj.scriptFile.find( { 
                type: type || 'jobSchedule',
                $or: [
                    { endAt: null },
                    { endAt: { $lte: nowTime } }
                ],
                $or: [
                    { nextRun: null }, 
                    { nextRun: { $lte: nowTime } }
                ],
                ...scheduleIdLimiter
            }).toArray();
        };

        obj.deletePendingJobsForNode = function(node) {
            return obj.scriptFile.deleteMany({ 
                type: 'job', 
                node: node,
                completeTime: null,
            });
        };

        obj.getPendingJobs = function(nodeScope) {
          if (nodeScope == null || !Array.isArray(nodeScope)) {
            return false;
          }
          // return jobs that has online nodes and queue time requirements have been met
          return obj.scriptFile.find( { 
              type: 'job', 
              node: { $in: nodeScope },
              completeTime: null,
              //dispatchTime: null,
              $or: [
                  { dontQueueUntil: null }, 
                  { dontQueueUntil: { $lte: Math.floor(new Date() / 1000) } }
              ]
          }).toArray();
        };

        obj.getJobNodeHistory = function(nodeId) {
            return obj.scriptFile.find( { 
                type: 'job', 
                node: nodeId,
            }).sort({ queueTime: -1 }).limit(200).toArray();
        };

        /**
         * Returns an array of Job for scriptId sorted desc by completeTime, then by queueTime.
         * Limits results to 200 items.
         * 
         * @param {string} scriptId 
         * @returns {Promise.<Array.<Job>>}
         */
        obj.getJobScriptHistory = function(scriptId) {
            return obj.scriptFile
                .find({ 
                    type: 'job', 
                    scriptId: scriptId,
                })
                .sort({ completeTime: -1, queueTime: -1 })
                .limit(200)
                .toArray();
        };

        obj.updateScriptJobName = function(scriptId, scriptName) {
            return obj.scriptFile.updateMany({ type: 'job', scriptId: scriptId }, { $set: { scriptName: scriptName } });    
        };

        /**
         * 
         * @param {string} scriptId 
         * @returns {Promise.<Array.<JobSchedule|MeshJobSchedule>>}
         */
        obj.getJobSchedulesForScript = function(scriptId) {
            return obj.scriptFile.find({
                type: { '$in': ['jobSchedule', 'meshJobSchedule'] },
                scriptId: scriptId
            }).toArray();
        };

        obj.getJobSchedulesForNode = function (nodeId) {
            return obj.scriptFile.find( { type: 'jobSchedule', node: nodeId } ).toArray();
        };

        /**
         * Returns incomplete jobs associated with a JobSchedule or MeshJobSchedule
         * @param {string} schedId 
         * @param {string|undefined} nodeId 
         * @returns {Array.<Job>}
         */
        obj.getIncompleteJobsForSchedule = function (schedId, nodeId) {
            return obj.scriptFile.find({
                type: 'job',
                state: 1, //scheduled
                jobSchedule: schedId,
                completeTime: null,
                ...(nodeId ? { node: nodeId } : undefined),
            }).toArray();
        };

        obj.deletePendingJobsForSchedule = function (schedId) {
            return obj.scriptFile.deleteMany( { type: 'job', jobSchedule: schedId, completeTime: null } );
        };

        obj.deleteOldHistory = function() {
            var nowTime = Math.floor(new Date() / 1000);
            var oldTime = nowTime - (86400 * 90); // 90 days
            return obj.scriptFile.deleteMany( { type: 'job', completeTime: { $lte: oldTime } } );
        };

        obj.addVariable = function(name, scope, scopeTarget, value) {
            var vObj = { 
                type: 'variable',
                name: name,
                scope: scope,
                scopeTarget: scopeTarget,
                value: value
            };
            return obj.scriptFile.insertOne(vObj);
        };

        obj.getVariables = function(limiters) {
            if (limiters != null) {
                var find = { 
                    type: 'variable',
                    name: { $in: limiters.names },
                    $or: [ 
                        { scope: 'global' },
                        { $and: [
                            { scope: 'script' },
                            { scopeTarget: limiters.scriptId }
                          ]
                        },
                        { $and: [
                            { scope: 'mesh' },
                            { scopeTarget: limiters.meshId }
                          ]
                        },
                        { $and: [
                            { scope: 'node' },
                            { scopeTarget: limiters.nodeId }
                          ]
                        }
                    ]
                };
                return obj.scriptFile.find(find).sort({ name: 1 }).toArray();
            }
            else {
                return obj.scriptFile.find({ type: 'variable' }).sort({ name: 1 }).toArray();
            }
        };

        obj.checkDefaults = function() {
            obj.scriptFile.find( { type: 'folder', name: 'Shared', path: 'Shared' } ).toArray()
            .then(found => {
              if (found.length == 0) obj.addFolder('Shared', 'Shared');
            })
            .catch(e => { console.log('PLUGIN: ScriptTask: Default folder check failed. Error was: ', e); });
        };
        
        obj.checkDefaults();
    };
    
    if (meshserver.args.mongodb) { // use MongDB
      require('mongodb').MongoClient.connect(meshserver.args.mongodb, { useNewUrlParser: true, useUnifiedTopology: true }, function (err, client) {
          if (err != null) { console.log("Unable to connect to database: " + err); process.exit(); return; }
          
          var dbname = 'meshcentral';
          if (meshserver.args.mongodbname) { dbname = meshserver.args.mongodbname; }
          const db = client.db(dbname);
          
          obj.scriptFile = db.collection('plugin_scripttask');
          obj.scriptFile.indexes(function (err, indexes) {
              // Check if we need to reset indexes
              var indexesByName = {}, indexCount = 0;
              for (var i in indexes) { indexesByName[indexes[i].name] = indexes[i]; indexCount++; }
              if ((indexCount != 6) || (indexesByName['ScriptName1'] == null) || (indexesByName['ScriptPath1'] == null) || (indexesByName['JobTime1'] == null) || (indexesByName['JobNode1'] == null) || (indexesByName['JobScriptID1'] == null)) {
                  // Reset all indexes
                  console.log('Resetting plugin (ScriptTask) indexes...');
                  obj.scriptFile.dropIndexes(function (err) {
                      obj.scriptFile.createIndex({ name: 1 }, { name: 'ScriptName1' });
                      obj.scriptFile.createIndex({ path: 1 }, { name: 'ScriptPath1' });
                      obj.scriptFile.createIndex({ queueTime: 1 }, { name: 'JobTime1' });
                      obj.scriptFile.createIndex({ node: 1 }, { name: 'JobNode1' });
                      obj.scriptFile.createIndex({ scriptId: 1 }, { name: 'JobScriptID1' });
                  }); 
              }
          });
          
          
          if (typeof require('mongodb').ObjectID == 'function') {
              formatId = require('mongodb').ObjectID;
          } else {
              formatId = require('mongodb').ObjectId;
          }
          obj.initFunctions();
    });  
    } else { // use NeDb
        Datastore = require('@yetzt/nedb');
        if (obj.scriptFilex == null) {
            obj.scriptFilex = new Datastore({ filename: meshserver.getConfigFilePath('plugin-scripttask.db'), autoload: true });
            obj.scriptFilex.persistence.setAutocompactionInterval(40000);
            obj.scriptFilex.ensureIndex({ fieldName: 'name' });
            obj.scriptFilex.ensureIndex({ fieldName: 'path' });
            obj.scriptFilex.ensureIndex({ fieldName: 'queueTime' });
            obj.scriptFilex.ensureIndex({ fieldName: 'node' });
            obj.scriptFilex.ensureIndex({ fieldName: 'scriptId' });
        }
        obj.scriptFile = new NEMongo(obj.scriptFilex);
        formatId = function(id) { return id; };
        obj.initFunctions();
    }
    
    return obj;
}