#!/usr/bin/env node

var crypto = require('crypto')
var fs = require('fs')
var cluster = require('cluster');
var numCPUs = require('os').cpus().length;
var cp = require('child_process')
var exec = cp.exec
var spawn = cp.spawn
var body
//exec('git cat-file -p 00000018e518e', function(err, stdout) { if(err) throw err; body = stdout; console.log(body);}), 1

var timestamp = Math.round(Date.now() / 1000); //`date +%s`.strip
var difficulty = fs.readFileSync('difficulty.txt').toString();

if (cluster.isMaster) {

    console.log('difficulty is ', difficulty);
    
    var data = {};
    
    exec('git write-tree', function(err, stdout) { 

        if(err) throw err; 
        data.tree = stdout.trim();

        exec('git rev-parse HEAD', function(err, stdout) { 
            if(err) throw err; 
            data.parent = stdout.trim();
    
            for (var i = 0; i < numCPUs; i++) {
                cluster.fork().send(data);
            }
    
            var resetting = false;

            cluster.on('exit', function(worker, code, signal) {
                if (resetting) return;
                if ( !code ) {
                    process.exit(0)
                } else {
                    console.log('worker %d died (%s). restarting...', worker.process.pid, signal || code);
                    cluster.fork().send(data);
                }
            });
    
            // pre-emptively check for new work
            function checkRemote() {
                //console.log('checking if local repo is up-to-date');
                exec('git remote update', function(err, stdout) {
                    console.log(stdout);
                    if (err) throw err;
                    if (stdout.indexOf('->') != -1) {
                        console.log('someone else minted a coin, killing this line of inquiry :/');
                        resetting = true;
                        // kill all workers - no sense in crunching numbers when we know the result won't be acceptable
                        for (var id in cluster.workers) {
                            cluster.workers[id].kill()
                        }
                        process.exit(1);
                    } else {
                        console.log('local repo is still up to date :)')
                        setTimeout(checkRemote, 1000);
                    }
                });
            }
            checkRemote();
        })
    })

} else {

    var counter = 0;

    body = ""

    var sha1 = "ffffffff"
    var tree, parent, bodyStart;
    
    process.on('message', function(data) {
        tree = data.tree;
        parent = data.parent;
        if (!tree || !parent) return;
        bodyStart = "tree " + tree + "\nparent " + parent + "\nauthor CTF user <me@example.com> " + timestamp + " +0000\ncommitter CTF user <me@example.com>"  + timestamp + " +0000\n\nGive me a Gitcoin ";
        console.log('worker %d starting to hash...', process.pid);
        mine();
    });
    
    function mine() {

        var lastTime = Date.now()
        var lastCount = counter

        while(true) {
            counter++;
            body = bodyStart + process.pid + counter;
            sha1 = crypto.createHash('sha1').update('commit ' + Buffer.byteLength(body) + '\0' + body).digest('hex')
            if (counter % 1000000 == 0) {
                var seconds =  (Date.now() - lastTime)/1000;
                var hashrate = Math.round((counter-lastCount) / seconds);
                console.log('worker %s\'s hashrate: %s', process.pid, hashrate);
                lastTime = Date.now();
                lastCount = counter;
                process.nextTick(mine);
                break;
            }
            if (sha1 < difficulty ) {
                saveSuccessfulResult();
                break;
            }
        }
        
    }
    

    function saveSuccessfulResult() {
        console.log(body);
        var git = spawn('git', ['hash-object', '-t', 'commit', '--stdin']);

        git.stdout.setEncoding('utf8');
        git.stdout.on('data', function(gitSha) {
            if (sha1 == gitSha.trim()) {
                console.log( "hooray!", sha1)
                git = spawn('git', ['hash-object', '-t', 'commit', '-w', '--stdin']);
                git.on('exit', function(code) {
                    exec('git reset --hard "' + sha1 + '" > /dev/null', function(err, stdout) { 
                        if(err) throw err; 
                        else process.exit(0)
                    })
                })
                git.stdin.write(body);
                git.stdin.end();
            } else {
                console.log( "darn\n", body, "\nnode:", sha1, "\ngit: ", gitSha);
                process.exit(1);
            }
        });

        git.stderr.setEncoding('utf8')
        git.stderr.on('data', console.error.bind(console, 'git stderr:'));

        git.stdin.write(body);
        git.stdin.end();
    
    }

}
