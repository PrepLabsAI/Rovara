import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { it } from "vitest";


// A proof owns /mnt/workspace and /run/agentx-close-retention while it runs. Its own teardown runs inside the process that still holds journal descriptors, so a mount can stay busy and the NEXT proof (or the grid's
// baseline) then fails "host already owns workspace path". Every proof therefore ends with a FRESH root process that detaches what the proof made, however the proof ended: lazy recursive unmounts, the loop devices
// backing /mnt/workspace, the serve helper, then the directories. It runs only after a proof that started (this suite refuses a host that already used those paths before it begins).
const teardownScript = String.raw`
set +u
R=/mnt/workspace; V=/run/agentx-close-retention
# Holders: any process whose cwd, root, an open descriptor or a mapping points under the proof's paths (this shell excluded).
holders() {
  for p in /proc/[0-9]*; do
    pid=$(basename "$p"); [ "$pid" = "$$" ] && continue
    hit=""
    for link in "$p/cwd" "$p/root" "$p"/fd/*; do
      target=$(readlink "$link" 2>/dev/null) || continue
      case "$target" in "$R"|"$R"/*|"$V"|"$V"/*) hit="$link -> $target"; break;; esac
    done
    [ -z "$hit" ] && grep -qE " ($R|$V)(/| )" "$p/maps" 2>/dev/null && hit="maps"
    [ -n "$hit" ] && echo "$pid $(tr '\0' ' ' < "$p/cmdline" 2>/dev/null | cut -c1-160) via $hit"
  done
}
# The serve helper first, by a pattern that cannot match this very command line.
pkill -f 'close-retention[.]sh serve' 2>/dev/null
loops=$(losetup -a 2>/dev/null | grep "$R/" | cut -d: -f1)
holders | while read -r pid rest; do kill -9 "$pid" 2>/dev/null; done
sleep 1
# Every mount under the proof's paths, deepest first, lazily.
awk -v r="$R" -v v="$V" '{m=$2; if (m==r||index(m,r"/")==1||m==v||index(m,v"/")==1) print m}' /proc/mounts | sort -r | while read -r m; do umount -l "$m" 2>/dev/null; done
for device in $loops; do blockdev --setrw "$device" 2>/dev/null; losetup --detach "$device" 2>/dev/null; done
rm -rf "$V" "$R" 2>/dev/null
if [ -e "$R" ] || [ -e "$V" ]; then
  echo "STILL PRESENT after teardown: $R=$([ -e "$R" ] && echo yes || echo no) $V=$([ -e "$V" ] && echo yes || echo no)"
  echo "--- mounts"; grep -E "workspace|agentx-close" /proc/mounts
  echo "--- loop devices"; losetup -a
  echo "--- holders"; holders
  echo "--- rm"; rm -rf "$R" 2>&1 | head -5
  exit 1
fi
`;
async function teardownProofHost(): Promise<string | undefined> {
  try { await promisify(execFile)("sudo", ["-n", "bash", "-c", teardownScript], { timeout: 60_000 }); return undefined; }
  catch (error) { const failed = error as { stdout?: string; stderr?: string }; return "teardown could not release the proof host:\n" + String(failed.stdout ?? "") + String(failed.stderr ?? error); }
}
async function runRootProof(proof: string, image: string, timeout: number) {
  let failure: Error | undefined;
  try { await promisify(execFile)("sudo", ["-n", "env", "CODE_CI_LINUX=1", process.execPath, "--input-type=module", "-e", proof, resolve(import.meta.dirname, "../.."), image], { timeout, maxBuffer: 1_048_576 }); }
  catch (error) { failure = new Error((error as { stderr?: string }).stderr ?? "root proof failed without stderr", { cause: error }); }
  const leftover = await teardownProofHost();
  if (failure !== undefined) throw new Error(failure.message + (leftover === undefined ? "" : "\n" + leftover), { cause: failure.cause });
  if (leftover !== undefined) throw new Error(leftover);
}

// Manual Linux proof only; CODE_CI_LINUX=1 activates both cases and missing images fail.
// This owns /mnt/workspace, its loop files and exact container/PIDs; it refuses a host already using them.
it.runIf(process.env.CODE_CI_LINUX === "1")("kernel seal excludes old descriptors/mappings, container restarts and delayed same-fence work; a restarted worker verifies without inspection", async () => {
  const image = process.env.CLOSE_RETENTION_TEST_IMAGE;
  if (image === undefined || !/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/u.test(image)) throw new Error("manual proof needs an already-installed digest-pinned Linux worker image");
  await runRootProof(linuxProof, image, 180_000);
}, 190_000);

const linuxProof = String.raw`
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {mkdir,writeFile,readFile,lstat,rm,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const [repository,image]=process.argv.slice(1), ROOT='/mnt/workspace', RUN='/run/agentx-close-retention';
const exec=promisify(execFile), command=async(...args)=>(await exec(args[0],args.slice(1))).stdout.trim();
assert.equal(process.platform,'linux'); assert.equal(process.getuid(),0);
assert.equal(await lstat(ROOT).then(()=>true,()=>false),false,'host already owns workspace path');
assert.equal(await lstat(RUN).then(()=>true,()=>false),false,'host already owns retention helper path');
assert.equal(await command('docker','ps','--all','--quiet'),'','proof needs a disposable Docker host');
await command('docker','image','inspect',image);
let owned=false, daemon, writer, container, loops=[];
const module=async(path)=>import(pathToFileURL(repository+'/'+path).href);
try {
  await mkdir(ROOT); owned=true; await command('mount','-t','tmpfs','-o','size=1G','tmpfs',ROOT);
  await mkdir(ROOT+'/repo'); await mkdir(ROOT+'/.agentx');
  await command('git','init','-b','main',ROOT+'/repo');
  await writeFile(ROOT+'/repo/value','original\n');
  await command('git','-C',ROOT+'/repo','add','.');
  await command('git','-C',ROOT+'/repo','-c','user.name=Proof','-c','user.email=proof@example.invalid','commit','-m','fixture');
  const commit=await command('git','-C',ROOT+'/repo','rev-parse','HEAD');
  await writeFile(ROOT+'/.agentx/preparation-manifest.json',JSON.stringify({schemaVersion:2,complete:true,projectName:'proof',projectRevision:1,repositories:[{name:'proof',path:'repo',defaultBranch:'main',resolvedCommit:commit,resolvedAt:new Date().toISOString(),completedAt:new Date().toISOString()}]}));
  const workspaceId=randomUUID(), operationId=randomUUID();
  const helper=repository+'/packages/worker/ec2/close-retention.sh';
  await command('bash',helper,'init',workspaceId,'3','i-0123456789abcdef0','vol-0123456789abcdef0');
  daemon=spawn('bash',[helper,'serve',workspaceId,'3','i-0123456789abcdef0','vol-0123456789abcdef0'],{stdio:['ignore','ignore','pipe']});
  for(let i=0;i<100;i++){if(await lstat(RUN+'/control.sock').then(()=>true,()=>false))break;await new Promise(r=>setTimeout(r,20));}
  const {OperationJournal}=await module('packages/worker/dist/journal.js');
  const {HostCloseRetentionStorage}=await module('packages/worker/dist/close-retention-storage.js');
  const {CloseRetentionExecutor}=await module('packages/worker/dist/close-retention.js');
  const {inspectWorkspaceForClose}=await module('packages/worker/dist/close-workspace.js');
  const {createWorkerServerState,handleWorkerRequest}=await module('packages/worker/dist/server.js');
  const journal=new OperationJournal(ROOT+'/data',ROOT+'/.agentx-control/journal'), storage=new HostCloseRetentionStorage();
  const generation=await storage.identity(); let inspections=0, writes=0;
  const executor=new CloseRetentionExecutor(journal,storage,async()=>{inspections++;return inspectWorkspaceForClose(ROOT+'/data');},()=>false);
  const state=createWorkerServerState(journal,{execute:async()=>{writes++;},retention:i=>executor.answer(i),admit:i=>executor.admitWriter(i)});
  const invocation={protocolVersion:1,kind:'close',workspaceId,operationId,fence:9,projectRevision:1,callbackCapability:'c'.repeat(64),payload:{schemaVersion:1,action:'retain',target:generation}};
  const send=async(i)=>{const response=await handleWorkerRequest(new Request('http://worker/invocations',{method:'POST',body:JSON.stringify(i)}),state);return {status:response.status,body:await response.json()};};
  writer=spawn('python3',['-u','-c','import sys,mmap; f=open(sys.argv[1],"r+b"); m=mmap.mmap(f.fileno(),0); print("ready",flush=True); sys.stdin.readline(); m[0:1]=b"X"; m.flush(); print("wrote",flush=True); sys.stdin.readline()',ROOT+'/data/repo/value'],{stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:writer.stdout})[Symbol.asyncIterator]();
  assert.equal((await lines.next()).value,'ready');
  assert.equal((await send(invocation)).body.status,'unavailable','an old fd/mmap must prevent proof');
  writer.stdin.write('write\n'); assert.equal((await lines.next()).value,'wrote');
  writer.stdin.end('stop\n'); await once(writer,'exit'); writer=undefined;
  container=await command('docker','create','--restart=always','--mount','type=bind,source='+ROOT+'/data,target=/data',image,'sh','-c','echo container >>/data/repo/value; sleep 120');
  await command('docker','start',container);
  assert.equal((await send(invocation)).body.status,'unavailable','an old mounted container must prevent proof');
  await command('docker','stop','-t','1',container); await command('docker','start',container);
  assert.equal((await send(invocation)).body.status,'unavailable','restart policy must not manufacture a proof');
  await command('docker','rm','--force',container); container=undefined;
  const retained=(await send(invocation)).body; assert.equal(retained.status,'retained'); assert.equal(inspections,1);
  const delayed=await send({...invocation,kind:'resume',operationId:randomUUID(),payload:{}});
  assert.equal(delayed.status,409); assert.equal(writes,0);
  await assert.rejects(writeFile(ROOT+'/data/repo/value','forbidden'));
  const restarted=await command('docker','create','--mount','type=bind,source='+ROOT+'/data,target=/data',image,'sh','-c','echo forbidden >>/data/repo/value'); container=restarted;
  await command('docker','start','--attach',container).catch(()=>{});
  assert.notEqual(await command('docker','inspect','--format','{{.State.ExitCode}}',container),'0','container wrote retained filesystem');
  await command('docker','rm','--force',container); container=undefined;
  const queryId=randomUUID();
  const verification=await new CloseRetentionExecutor(new OperationJournal(ROOT+'/data',ROOT+'/.agentx-control/journal'),new HostCloseRetentionStorage(),async()=>{throw new Error('restart must not inspect');},()=>false).answer({...invocation,operationId:randomUUID(),fence:10,payload:{schemaVersion:1,action:'verify',retention:retained.retention,queryId}});
  assert.equal(verification.status,'verified'); assert.equal(verification.verified,true); assert.equal(verification.queryId,queryId); assert.equal(inspections,1);
  // A retained generation is detached and restored, with a persisted restart-policy container running first.
  daemon.kill('SIGTERM');await once(daemon,'exit');daemon=undefined;
  await command('umount','--recursive',RUN+'/view');
  const backing=ROOT+'/.agentx-control/generations/'+generation.dataGeneration+'.ext4';
  const device=await command('losetup','--associated',backing,'--output','NAME','--noheadings');
  await command('umount',ROOT+'/data');await command('blockdev','--setrw',device);await command('losetup','--detach',device);
  container=await command('docker','run','-d','--restart=always',image,'sleep','300');
  const boot=await readFile(repository+'/packages/worker/ec2/boot.sh','utf8');
  const fn=name=>{const a=boot.indexOf('\n'+name+'() {');const b=boot.indexOf('\n}\n',a);assert.ok(a>=0&&b>a);return boot.slice(a+1,b+3);};
  await assert.rejects(command('bash',helper,'init',workspaceId,'3','i-0123456789abcdef0','vol-0123456789abcdef0'));
  await command('bash','-c','set -euo pipefail\nBOOT_DEADLINE=$((SECONDS+480))\nFAILURE_FILE=/tmp/close-retention-reboot-failure\n'+['log','fail','try_seconds','quiesce_workspace_containers'].map(fn).join('\n')+'\nquiesce_workspace_containers');
  assert.equal(await command('docker','inspect','--format','{{.State.Running}}',container),'false');
  assert.equal(await command('bash',helper,'init',workspaceId,'3','i-0123456789abcdef0','vol-0123456789abcdef0'),'migrated');
  assert.ok((await command('findmnt','-n','-o','OPTIONS','--target',ROOT+'/data')).split(',').includes('ro'));
  assert.equal(await command('blockdev','--getro',await command('findmnt','-n','-o','SOURCE','--target',ROOT+'/data')),'1');
  await assert.rejects(writeFile(ROOT+'/data/repo/value','forbidden after reboot'));
  await command('docker','rm',container);container=undefined;
  daemon=spawn('bash',[helper,'serve',workspaceId,'3','i-0123456789abcdef0','vol-0123456789abcdef0'],{stdio:['ignore','ignore','pipe']});
  // The previous serve's control socket FILE outlives it, and current.json is already published by the restore: wait for a CONNECTION that works, or the verify below meets ECONNREFUSED (which it reports as verified:false).
  for(let i=0;i<200;i++){try{await storage.withOwnership('read',async()=>true);break;}catch{await new Promise(r=>setTimeout(r,25));}}
  const rebooted=await new CloseRetentionExecutor(new OperationJournal(ROOT+'/data',ROOT+'/.agentx-control/journal'),new HostCloseRetentionStorage(),async()=>{throw new Error('retained reboot must not inspect');},()=>false).answer({...invocation,operationId:randomUUID(),fence:10,payload:{schemaVersion:1,action:'verify',retention:retained.retention,queryId:randomUUID()}});
  assert.equal(rebooted.status,'verified');assert.equal(rebooted.verified,true);
  const pointer=await readFile(ROOT+'/.agentx-control/current.json','utf8');
  const stale=await send({...invocation,operationId:randomUUID(),fence:10,payload:{schemaVersion:1,action:'destroy',retention:{...retained.retention,generation:{...generation,dataGeneration:randomUUID()}},effectId:'stale',machineIds:['machine']}});
  assert.notEqual(stale.body.status,'destroy_authorized'); assert.equal(await readFile(ROOT+'/.agentx-control/current.json','utf8'),pointer);
  // A task running as root could have changed the data filesystem root's owner before sealing.
  // Host-only fixture preparation reproduces that state; the successor must refuse before mounting over it.
  let oldDevice=await command('findmnt','-n','-o','SOURCE','--target',ROOT+'/data');
  // The restore attached the retained generation with a READ-ONLY loop (losetup --read-only: a flag a remount cannot clear), so the fixture re-attaches the image read-write, changes the owner, and attaches it read-only again, with the serve helper stopped meanwhile.
  const owner=async uid=>{
    const backing=ROOT+'/.agentx-control/generations/'+generation.dataGeneration+'.ext4';
    daemon.kill('SIGTERM');await once(daemon,'exit');daemon=undefined;
    await command('umount','--recursive',RUN+'/view').catch(()=>{});
    await command('umount',ROOT+'/data');await command('blockdev','--setrw',oldDevice).catch(()=>{});await command('losetup','--detach',oldDevice);
    const rw=await command('losetup','--find','--show',backing);
    await command('mount','-t','ext4','-o','rw,noatime',rw,ROOT+'/data');await command('chown',uid+':'+uid,ROOT+'/data');await command('umount',ROOT+'/data');
    await command('blockdev','--setrw',rw);await command('losetup','--detach',rw);
    oldDevice=await command('losetup','--find','--show','--read-only',backing);
    await command('mount','-t','ext4','-o','ro,noload,noatime',oldDevice,ROOT+'/data');
    daemon=spawn('bash',[helper,'serve',workspaceId,'3','i-0123456789abcdef0','vol-0123456789abcdef0'],{stdio:['ignore','ignore','pipe']});
    for(let i=0;i<200;i++){try{await storage.withOwnership('read',async()=>true);break;}catch{await new Promise(r=>setTimeout(r,25));}}
  };
  await owner(1001);
  const successorId=randomUUID(), successor={...invocation,kind:'task',operationId:successorId,fence:11,payload:{conversationId:randomUUID(),prompt:'new work'},supersedesRetention:retained.retention};
  await journal.accept(successor); await journal.raiseFence(workspaceId,11); // the order of the executor's own hand-over (accept, raise the fence, then the host's successor): a restart between them must still validate
  await assert.rejects(storage.withOwnership('write',()=>storage.successor(successorId)),'successor refuses foreign data owner');
  await owner(1000);
  const next=await storage.withOwnership('write',()=>storage.successor(successorId));
  assert.notEqual(next.dataGeneration,generation.dataGeneration);await writeFile(ROOT+'/data/repo/value','successor work');
  assert.equal(await command('blockdev','--getro',oldDevice),'1');

} finally {
  if(writer){writer.kill('SIGTERM');await once(writer,'exit').catch(()=>{});}
  if(container)await command('docker','rm','--force',container).catch(()=>{});
  // A process that already exited never emits 'exit' again: waiting for it leaves the proof's top-level await unsettled (exit code 13).
  if(daemon&&daemon.exitCode===null&&daemon.signalCode===null){daemon.kill('SIGTERM');await once(daemon,'exit').catch(()=>{});}
  if(owned){
    for(const name of await readdir(ROOT+'/.agentx-control/generations').catch(()=>[])){
      const result=await command('losetup','--associated',ROOT+'/.agentx-control/generations/'+name,'--output','NAME','--noheadings').catch(()=>'');loops.push(...result.split('\n').filter(Boolean));
    }
    await command('umount','--recursive',RUN+'/view').catch(()=>{});
    await command('umount','--recursive',ROOT).catch(()=>{});
    for(const device of loops){await command('blockdev','--setrw',device).catch(()=>{});await command('losetup','--detach',device).catch(()=>{});}
    await rm(RUN,{recursive:true,force:true}).catch(()=>{}); await rm(ROOT,{recursive:true,force:true}).catch(()=>{});
  }
}
`;

// CODE_CI_LINUX=1 on a disposable systemd/Docker Linux host.
// The manual CI preparation builds, pushes to loopback, and pulls the worker by digest.
// No registry login/pull, AWS call or network dependency; the production extraction/install bodies run unchanged.
it.runIf(process.env.CODE_CI_LINUX === "1")("boot v2 extracts the pinned bytes in an inspected isolated Docker container, masks task root in both layouts and restores on reboot", async () => {
  if (process.env.CODE_CI_LINUX !== "1") throw new Error("manual Linux proof requires CODE_CI_LINUX=1");
  const image = process.env.CLOSE_RETENTION_TEST_IMAGE;
  if (image === undefined || !/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/u.test(image)) throw new Error("preload the final worker image by digest");
  await runRootProof(bootV2Proof, image, 300_000);
}, 310_000);

const bootV2Proof = String.raw`
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {mkdir,writeFile,readFile,lstat,rm,readdir,chmod,chown,symlink,link,unlink} from 'node:fs/promises';
import {randomUUID,createHash,generateKeyPairSync} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const [repository,image]=process.argv.slice(1), ROOT='/mnt/workspace', RUN='/run/agentx-close-retention', HOST='/run/agentx-close-retention-host';
const exec=promisify(execFile), cmd=async(...a)=>(await exec(a[0],a.slice(1),{timeout:180000,maxBuffer:1048576})).stdout.trim();
assert.equal(process.platform,'linux'); assert.equal(process.getuid(),0);
assert.match(image,/^(?:localhost:[0-9]+\/close-retention|[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9._/-]+)@sha256:[0-9a-f]{64}$/);
for(const p of [ROOT,RUN,HOST,'/etc/agentx','/usr/local/libexec/agentx-worker-start','/usr/local/libexec/agentx-retention-restore','/run/agentx-boot-failure','/var/lib/rovara-egress','/usr/local/libexec/rovara-sandbox-egress-restore','/etc/systemd/system/rovara-sandbox-egress.service','/etc/systemd/system/agentx-worker.service','/etc/systemd/system/agentx-close-retention-restore.service'])assert.equal(await lstat(p).then(()=>true,()=>false),false,'disposable host required: '+p);
assert.equal(await cmd('docker','ps','--all','--quiet'),''); const installed=JSON.parse(await cmd('docker','image','inspect',image))[0];assert.ok(installed.RepoDigests.includes(image));
for(const unit of ['agentx-worker.service','agentx-close-retention.service','agentx-close-retention-restore.service','rovara-sandbox-egress.service','rovara-test-services.service'])assert.equal(await cmd('systemctl','show','--property=LoadState','--value',unit),'not-found');
const boot=await readFile(repository+'/packages/worker/ec2/boot.sh','utf8'), helper=await readFile(repository+'/packages/worker/ec2/close-retention.sh');
const hash=createHash('sha256').update(helper).digest('hex');assert.ok(boot.includes('readonly CLOSE_HELPER_SHA256='+hash));
const fn=name=>{const a=boot.indexOf('\n'+name+'() {');const b=boot.indexOf('\n}\n',a);assert.ok(a>=0&&b>a);return boot.slice(a+1,b+3);};
const workspace=randomUUID(), scope=[workspace,'3','i-0123456789abcdef0','vol-0123456789abcdef0'];
const program=(digest=hash)=>'set -euo pipefail\nHOST_RUN='+HOST+'\nCLOSE_HELPER_SHA256='+digest+'\nAGENTX_WORKER_IMAGE='+image+'\nAGENTX_WORKSPACE_ID='+workspace+'\nAGENTX_SESSION_GENERATION=3\nAGENTX_VOLUME_ID='+scope[3]+'\nBOOT_DEADLINE=$((SECONDS+480))\nFAILURE_FILE=/run/agentx-boot-failure\n'+['log','fail','try_seconds','quiesce_workspace_containers','initialize_close_retention'].map(fn).join('\n')+'\ninitialize_close_retention '+scope[2];
let owned=false, events, task, legacyProcess, readyWorker, gatewayOwned=false, service=false, mounts=[], maskVolumes=[];
const module=path=>import(pathToFileURL(repository+'/'+path).href);
const quiesce=fn('main').split('  BOOT_STEP=')[0]+'}\nmain';
const quiesceProgram='set -euo pipefail\nWORKER_UNIT=agentx-worker.service\nRESTORE_UNIT=agentx-close-retention-restore.service\n'+['log','fail'].map(fn).join('\n')+'\n'+quiesce;
const unitPaths=['agentx-worker.service','agentx-close-retention.service','agentx-close-retention-restore.service','rovara-sandbox-egress.service','rovara-test-services.service'].map(unit=>'/etc/systemd/system/'+unit);
async function cleanQuiesceUnits(){
  for(const path of unitPaths)await writeFile(path,'[Service]\nExecStart=/bin/sleep 300\n');
  await cmd('systemctl','daemon-reload');
  for(const unit of ['agentx-worker.service','agentx-close-retention.service','agentx-close-retention-restore.service','rovara-sandbox-egress.service','rovara-test-services.service'])await cmd('systemctl','stop',unit);
  for(const path of unitPaths)await rm(path);
  await cmd('systemctl','daemon-reload');
}
async function refusesServe(arguments_){
  const child=spawn('bash',[HOST+'/helper.sh','serve',...arguments_],{stdio:'ignore'});
  try{const ended=await Promise.race([once(child,'exit'),new Promise(r=>setTimeout(()=>r(null),1500))]);assert.ok(ended,'serve rejects foreign workspace or ownership lock refused or control mount aliases refused');assert.notEqual(ended[0],0,'ownership lock refused');}
  finally{if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit').catch(()=>{});}}
}
const publicKey=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({format:'der',type:'spki'}).toString('base64');
async function workerArguments(){
  const emitted=await exec('bash',['-euc','args=(); MOUNT_PATH=/mnt/workspace; . "$1"; printf "%s\\0" "$'+'{args[@]}"','worker-args',HOST+'/worker-mounts']);
  return ['--env','AGENTX_RUNTIME=ec2','--env','AGENTX_WORKSPACE_ROOT=/mnt/workspace','--env','AGENTX_WORKSPACE_ID='+workspace,'--env','AGENTX_SESSION_GENERATION=3','--env','AGENTX_INVOKE_PUBLIC_KEY='+publicKey,...emitted.stdout.split('\0').filter(Boolean)];
}
async function waitReady(id,layout){
  let last='';
  for(let attempt=0;attempt<150;attempt++){
    try{last=await cmd('docker','exec',id,'node','-e','fetch("http://127.0.0.1:8080/ping").then(async r=>{if(r.status!==200)throw new Error(await r.text());console.log(await r.text())})');const ping=JSON.parse(last);assert.equal(ping.status,'Healthy');assert.equal(ping.workspaceDataIdentity!==undefined,layout==='migrated');return;}catch(error){last=String(error);}
    if(await cmd('docker','inspect','--format','{{.State.Running}}',id)==='false')break;
    await new Promise(r=>setTimeout(r,200));
  }
  assert.fail('worker readiness '+layout+': '+last+'\n'+await cmd('docker','logs',id));
}
async function proveWorkerReady(layout){
  readyWorker=await cmd('docker','run','-d','--network','none',...await workerArguments(),image);
  try{await waitReady(readyWorker,layout);}finally{await cmd('docker','rm','--force',readyWorker);readyWorker=undefined;}
}
async function resetRuntime(){
  if(service){await cmd('systemctl','stop','agentx-close-retention.service').catch(()=>{});service=false;}
  await cmd('umount','--recursive',RUN+'/view').catch(()=>{});
  await cmd('umount',RUN+'/journal').catch(()=>{});
  for(const name of await readdir(ROOT+'/.agentx-control/generations').catch(()=>[])){
    const devices=(await cmd('losetup','--associated',ROOT+'/.agentx-control/generations/'+name,'--output','NAME','--noheadings')).split('\n').filter(Boolean);
    await cmd('umount',ROOT+'/data').catch(()=>{}); for(const d of devices)await cmd('losetup','--detach',d);
  }
  await cmd('umount',HOST).catch(()=>{}); await rm(RUN,{recursive:true,force:true});await rm(HOST,{recursive:true,force:true});
}
try{
  // Only the main function's actual quiescence prefix; the later configuration/IMDS path is not entered.
  try{
    for(const path of unitPaths)await writeFile(path,'[Service]\nExecStart=/bin/sleep 300\n');
    await cmd('systemctl','daemon-reload');
    for(const unit of ['agentx-worker.service','agentx-close-retention.service','agentx-close-retention-restore.service','rovara-sandbox-egress.service','rovara-test-services.service'])await cmd('systemctl','start',unit);
    await cmd('bash','-c',quiesceProgram);
    for(const unit of ['agentx-worker.service','agentx-close-retention.service','agentx-close-retention-restore.service','rovara-sandbox-egress.service','rovara-test-services.service'])assert.notEqual(await cmd('systemctl','is-active',unit).catch(()=>''),'active','in-place units quiesced');
    await writeFile(unitPaths[0],'[Unit]\nRefuseManualStop=yes\n[Service]\nExecStart=/bin/sleep 300\n');
    await cmd('systemctl','daemon-reload');await cmd('systemctl','start','agentx-worker.service');
    await assert.rejects(cmd('bash','-c',quiesceProgram),'manual stop refusal');
  }finally{await cleanQuiesceUnits();}
  // Run the production RepoDigests check against real Docker metadata. Registry/pull boundaries are preloaded.
  const mismatchTag='close-retention-repodigests-b1:proof';await cmd('docker','tag',image,mismatchTag);
  try{
    const check=ref=>'set -euo pipefail\nAGENTX_WORKER_IMAGE='+ref+'\nFAILURE_FILE=/run/agentx-boot-failure\n'+['log','fail','pull_worker_image'].map(fn).join('\n')+'\nretry(){ shift; "$@"; }; registry_login(){ :; }; pull_image_once(){ :; }; pull_worker_image us-east-1';
    await cmd('bash','-c',check(image));await assert.rejects(cmd('bash','-c',check(mismatchTag)),'RepoDigests mismatch refused');
  }finally{await cmd('docker','image','rm',mismatchTag);}
  await cmd(process.execPath,repository+'/node_modules/vitest/vitest.mjs','run','tests/contract/close-retention-boot-preconditions.test.ts','tests/contract/close-retention-worker-layout.test.ts','tests/contract/ec2-sandbox-egress-stage.test.ts','tests/contract/ec2-test-services-stage.test.ts','-t','quiesces|restarts the exited|emits the container|emitted .*env and mounts|creates missing host runtime|orders gateway restoration|orders test services','--maxWorkers=1','--no-file-parallelism');
  await cmd('python3',repository+'/tests/linux/close-retention-host-probes.py');
  await cmd('python3',repository+'/tests/unit/close-retention-migration.test.py');
  await mkdir(ROOT);owned=true;
  // Real running/stopped persisted containers, unfinished journal and a user repository named data.
  for(const reason of ['running','stopped','journal','data','process']){
    await cmd('mount','-t','tmpfs','-o','size=512M','tmpfs',ROOT);
    if(reason==='running'||reason==='stopped'){
      task=await cmd('docker','create','--restart=always',image,'sleep','300');
      if(reason==='running')await cmd('docker','start',task);
    }
    if(reason==='data'){await mkdir(ROOT+'/data');await writeFile(ROOT+'/data/unsaved','preserve');}
    if(reason==='process'){await mkdir(ROOT+'/repo');legacyProcess=spawn('sleep',['300'],{cwd:ROOT+'/repo',stdio:'ignore'});await once(legacyProcess,'spawn');}
    const op=randomUUID();
    if(reason==='journal'){
      await mkdir(ROOT+'/.agentx/operations',{recursive:true,mode:0o700});
      await writeFile(ROOT+'/.agentx/operations/'+op+'.json',JSON.stringify({schemaVersion:1,operationId:op,workspaceId:workspace,fence:19,payloadHash:'a'.repeat(64),status:'RUNNING',acceptedAt:'2026-11-22T00:00:00.000Z',updatedAt:'2026-11-22T00:00:00.000Z'}),{mode:0o600});
      for(const path of [ROOT+'/.agentx',ROOT+'/.agentx/operations',ROOT+'/.agentx/operations/'+op+'.json'])await chown(path,1000,1000);
    }
    service=true;await assert.doesNotReject(cmd('bash','-c',program()),'install succeeds after control socket readiness');
    assert.equal(await lstat(HOST+'/worker-mounts').then(()=>true,()=>false),true,'install publishes worker mounts and control socket');
    assert.equal(await lstat(ROOT+'/.agentx-control/current.json').then(()=>true,()=>false),false);
    assert.equal(await lstat(ROOT+'/.agentx-control/journal/.agentx/operations').then(s=>s.isDirectory()),true);
    assert.ok((await readFile(HOST+'/worker-mounts','utf8')).includes('args+=(--volume "$MOUNT_PATH:$MOUNT_PATH")'));
    if(task){assert.equal(await cmd('docker','inspect','--format','{{.State.Running}}',task),'false');await cmd('docker','rm',task);task=undefined;}
    if(legacyProcess){legacyProcess.kill('SIGTERM');await once(legacyProcess,'exit');legacyProcess=undefined;}
    if(reason==='data')assert.equal(await readFile(ROOT+'/data/unsaved','utf8'),'preserve');
    if(reason==='journal'){
      assert.equal(JSON.parse(await readFile(ROOT+'/.agentx-control/journal/.agentx/operations/fences/'+workspace+'.json','utf8')),19,'legacy fence high-water');
      assert.equal(await lstat(ROOT+'/.agentx-control/journal/.agentx/operations/'+op+'.json').then(()=>true,()=>false),false,'legacy single journal authority');
      await proveWorkerReady('legacy');
      await cmd('docker','run','--rm','--network','none','--volume',ROOT+':'+ROOT,image,'node','--input-type=module','-e',"import {OperationJournal} from './packages/worker/dist/journal.js';await new OperationJournal('/mnt/workspace').transition('"+op+"','SUCCEEDED');");
      // Keep an existing devcontainer so this really is a second LEGACY boot after the status change.
      task=await cmd('docker','create',image,'sleep','300');
      await resetRuntime();service=true;await cmd('bash','-c',program());
      assert.equal(await lstat(ROOT+'/.agentx-control/current.json').then(()=>true,()=>false),false,'legacy status-change reboot');
      assert.equal(JSON.parse(await readFile(ROOT+'/.agentx/operations/'+op+'.json','utf8')).status,'SUCCEEDED','legacy latest journal status');
      await proveWorkerReady('legacy');await cmd('docker','rm',task);task=undefined;
      await resetRuntime();service=true;await cmd('bash','-c',program());
      assert.equal(JSON.parse(await readFile(ROOT+'/.agentx-control/journal/.agentx/operations/'+op+'.json','utf8')).status,'SUCCEEDED','migration copies latest legacy status');
      await proveWorkerReady('migrated');
    }
    await resetRuntime();await cmd('umount',ROOT);await rm(ROOT,{recursive:true});await mkdir(ROOT);
  }
  for(const [size,layout] of [['128M','legacy'],['1G','migrated']]){
    await cmd('mount','-t','tmpfs','-o','size='+size,'tmpfs',ROOT);
    await mkdir(ROOT+'/.agentx-control',{mode:0o755});
    await writeFile(ROOT+'/.agentx-control/helper.sh','#!/bin/bash\ntouch /mnt/workspace/PLANTED-FIRED\n',{mode:0o755});
    await chown(ROOT+'/.agentx-control',1001,1001);
    await assert.rejects(cmd('bash','-c',program()),'foreign control owner refused');
    assert.equal(await lstat(HOST+'/worker-mounts').then(()=>true,()=>false),false);
    await chown(ROOT+'/.agentx-control',0,0);await chmod(ROOT+'/.agentx-control',0o777);
    await assert.rejects(cmd('bash','-c',program()),'control directory mode refused');await chmod(ROOT+'/.agentx-control',0o700);
    await assert.rejects(cmd('bash','-c',program()),'control directory mode refused');await chmod(ROOT+'/.agentx-control',0o755);
    await resetRuntime();await mkdir(HOST,{mode:0o755});
    await assert.rejects(cmd('bash','-c',program()),'host runtime mode refused');await rm(HOST,{recursive:true});
    await mkdir(HOST,{mode:0o700});await chown(HOST,1001,1001);
    await assert.rejects(cmd('bash','-c',program()),'untrusted host runtime refused');await chown(HOST,0,0);await rm(HOST,{recursive:true});
    for(const options of ['nodev,suid,mode=0700','dev,nosuid,mode=0700']){
      await mkdir(HOST,{mode:0o700});await cmd('mount','-t','tmpfs','-o',options,'tmpfs',HOST);
      await assert.rejects(cmd('bash','-c',program()),'unsafe host runtime refused');await cmd('umount',HOST);await rm(HOST,{recursive:true});
    }
    await mkdir(HOST,{mode:0o700});await cmd('mount','-t','tmpfs','-o','nodev,nosuid,mode=0700,uid=0,gid=0','tmpfs',HOST);
    await writeFile(ROOT+'/untouched','original');await symlink(ROOT+'/untouched',HOST+'/worker-mounts');
    // Capture and inspect the real production extractor's Docker create event while it is alive.
    events=spawn('docker',['events','--filter','type=container','--filter','event=create','--format','{{.ID}}'],{stdio:['ignore','pipe','pipe']});
    const lines=createInterface({input:events.stdout})[Symbol.asyncIterator]();
    const inspected=(async()=>{const id=(await lines.next()).value;assert.ok(id);return JSON.parse(await cmd('docker','inspect',id))[0];})();
    service=true;await cmd('bash','-c',program());
    const extraction=await inspected;events.kill('SIGTERM');await once(events,'exit');events=undefined;
    assert.equal(extraction.HostConfig.NetworkMode,'none','extractor network isolation');assert.equal(extraction.HostConfig.ReadonlyRootfs,true);
    assert.deepEqual(extraction.HostConfig.CapDrop,['ALL']);assert.ok(extraction.HostConfig.SecurityOpt.some(option=>/^no-new-privileges(?:[:=]true)?$/.test(option)));
    assert.equal(extraction.HostConfig.Binds?.length??0,0);assert.equal(extraction.Mounts.length,0);
    assert.deepEqual(extraction.Config.Entrypoint,['/bin/cat']);assert.deepEqual(extraction.Config.Cmd,['/opt/agentx/packages/worker/ec2/close-retention.sh']);
    const args=await readFile(HOST+'/worker-mounts','utf8');assert.equal((await lstat(HOST+'/worker-mounts')).mode&0o777,0o444);assert.equal((await lstat(HOST+'/worker-mounts')).isSymbolicLink(),false);assert.equal(await readFile(ROOT+'/untouched','utf8'),'original');
    assert.equal((await lstat(HOST)).mode&0o777,0o700);assert.equal(await readFile(HOST+'/helper.sh','utf8'),helper.toString());
    assert.equal(await lstat(ROOT+'/PLANTED-FIRED').then(()=>true,()=>false),false,'planted helper did not execute');
    assert.ok(args.includes(layout==='legacy'?'--volume "$MOUNT_PATH:$MOUNT_PATH"':'AGENTX_WORKSPACE_ROOT=/mnt/workspace/data'),'legacy layout selected');
    const journal=await cmd('findmnt','-n','-o','OPTIONS','--target',RUN+'/journal'); for(const flag of ['noexec','nodev','nosuid'])assert.ok(journal.split(',').includes(flag));
    await proveWorkerReady(layout);
    // Start through the real worker devcontainer CLI/policy/mask path, in both layouts.
    const taskRoot=layout==='migrated'?ROOT+'/data':ROOT;
    const {createDevcontainerCli,ensureDevcontainer}=await module('packages/worker/dist/devcontainer.js');
    const cli=createDevcontainerCli({environment:{...process.env,AGENTX_RUNTIME:'ec2'}});
    const config=taskRoot+'/repo/.devcontainer/devcontainer.json';
    await mkdir(taskRoot+'/repo/.devcontainer',{recursive:true});
    await writeFile(config,JSON.stringify({image,workspaceMount:'source='+taskRoot+',target='+taskRoot+',type=bind',workspaceFolder:taskRoot+'/repo',remoteUser:'root',containerUser:'root'}));
    await mkdir(taskRoot+'/.agentx-control',{recursive:true,mode:0o755});await writeFile(taskRoot+'/.agentx-control/hidden','private');
    await chown(taskRoot+'/.agentx-control',1001,1001);
    const target={rootPath:taskRoot,workspaceFolder:taskRoot+'/repo',configPath:config};
    await assert.rejects(ensureDevcontainer(cli,target,{environment:{...process.env,AGENTX_RUNTIME:'ec2'}}));
    await chown(taskRoot+'/.agentx-control',0,0);
    task=(await ensureDevcontainer(cli,target,{environment:{...process.env,AGENTX_RUNTIME:'ec2'}})).containerId;
    const taskInspection=JSON.parse(await cmd('docker','inspect',task))[0];
    maskVolumes=taskInspection.Mounts.filter(m=>m.Type==='volume'&&/^agentx-(?:mask-|docker-data-mask-)/.test(m.Name)).map(m=>m.Name);
    await cmd('docker','exec','--user','0:0',task,'sh','-c','test -z "$(ls -A '+taskRoot+'/.agentx-control)" && ! umount '+taskRoot+'/.agentx-control && test ! -S /var/run/docker.sock && test ! -e /run/agentx-close-retention-host/helper.sh');
    await cmd('docker','rm','--force',task);task=undefined;
    if(maskVolumes.length)await cmd('docker','volume','rm',...maskVolumes);maskVolumes=[];
    // Same-device bind aliases must be rejected by all three real helper entry points.
    await mkdir(ROOT+'/.agentx',{recursive:true,mode:0o700});await cmd('mount','--bind',ROOT+'/.agentx',ROOT+'/.agentx');
    try{
      await assert.rejects(cmd('bash',HOST+'/helper.sh','init',...scope),'control mount aliases refused');
      if(layout==='migrated')await assert.rejects(cmd('bash',HOST+'/helper.sh','restore',...scope),'control mount aliases refused');
      await refusesServe(scope);
    }finally{await cmd('umount',ROOT+'/.agentx');}
    await cmd('bash','-c','args=();MOUNT_PATH=/mnt/workspace;. "$1"','source-mounts',HOST+'/worker-mounts');
    await cmd('systemctl','stop','agentx-close-retention.service');service=false;await rm(RUN+'/control.sock',{force:true});
    if(layout==='migrated')await refusesServe([randomUUID(),...scope.slice(1)]);
    await chmod(ROOT+'/.agentx-control/ownership.lock',0o666);await refusesServe(scope);await chmod(ROOT+'/.agentx-control/ownership.lock',0o600);
    await assert.rejects(cmd('bash','-c','args=();MOUNT_PATH=/mnt/workspace;. "$1"','source-mounts',HOST+'/worker-mounts'),'mount source refuses missing socket');
    await resetRuntime();
    // Reboot: the host tmpfs copy is gone; the same image must be extracted again.
    service=true;await cmd('bash','-c',program());assert.equal(await lstat(ROOT+'/PLANTED-FIRED').then(()=>true,()=>false),false,'planted helper did not execute');
    await resetRuntime();await cmd('umount',ROOT);await rm(ROOT,{recursive:true});await mkdir(ROOT);
  }
  // Exercise the real generated unit relationship, replacing only the registry step with preloaded-image execution.
  // Restore/install/launcher bodies, systemd, Docker, stat and chmod are real.
  await cmd('mount','-t','tmpfs','-o','size=128M','tmpfs',ROOT);
  const settings='WORKER_UNIT=agentx-worker.service RESTORE_UNIT=agentx-close-retention-restore.service FIREWALL_UNIT=docker.service MOUNT_PATH=/mnt/workspace WORKER_CONTAINER=agentx-worker AGENTX_LOG_GROUP=/close-retention-proof HOST_RUN='+HOST+' CLOSE_HELPER_SHA256='+hash+'\nAGENTX_WORKER_IMAGE='+image+' AGENTX_WORKSPACE_ID='+workspace+' AGENTX_SESSION_GENERATION=3 AGENTX_VOLUME_ID='+scope[3]+'\n';
  await cmd('bash','-c','set -euo pipefail\n'+settings+['write_worker_launcher','write_worker_unit','log','fail','try_seconds','tries','retry','registry_login','pull_image_once','pull_worker_image','quiesce_workspace_containers','initialize_close_retention'].map(fn).join('\n')+'\nwrite_worker_unit us-east-1 '+scope[2]);
  assert.equal((await lstat('/usr/local/libexec/agentx-retention-restore')).mode&0o777,0o700,'restore script mode');
  await writeFile('/usr/local/libexec/agentx-retention-restore',program('0'.repeat(64)),{mode:0o700});
  await cmd('systemctl','daemon-reload');await assert.rejects(cmd('systemctl','start','agentx-worker.service'),'wrong helper prevents worker start');
  assert.notEqual(await cmd('systemctl','is-active','agentx-worker.service').catch(()=>''),'active');
  assert.equal(await cmd('docker','ps','--all','--quiet','--filter','name=^/agentx-worker$'),'');
  assert.equal(await lstat(HOST+'/helper.sh').then(()=>true,()=>false),false);
  const sourceFile=HOST+'/worker-mounts';
  await writeFile(sourceFile,'touch /mnt/workspace/PLANTED-FIRED\n',{mode:0o444});await chown(sourceFile,1000,1000);
  await assert.rejects(cmd('/bin/bash','/usr/local/libexec/agentx-worker-start'),'untrusted mount source refused');
  assert.equal(await lstat(ROOT+'/PLANTED-FIRED').then(()=>true,()=>false),false,'planted helper did not execute');
  await chown(sourceFile,0,0);await chmod(sourceFile,0o666);
  await assert.rejects(cmd('/bin/bash','/usr/local/libexec/agentx-worker-start'),'untrusted mount source refused');
  await chmod(sourceFile,0o444);
  const linked=HOST+'/mounts-original';await cmd('mv',sourceFile,linked);await symlink(linked,sourceFile);
  await assert.rejects(cmd('/bin/bash','/usr/local/libexec/agentx-worker-start'),'untrusted mount source refused');await unlink(sourceFile);await cmd('mv',linked,sourceFile);
  await link(sourceFile,linked);await assert.rejects(cmd('/bin/bash','/usr/local/libexec/agentx-worker-start'),'untrusted mount source refused');await unlink(linked);
  await chmod(HOST,0o755);await assert.rejects(cmd('/bin/bash','/usr/local/libexec/agentx-worker-start'),'untrusted mount source refused');await chmod(HOST,0o700);
  await cmd('cp','-a',HOST,HOST+'-real');await cmd('umount',HOST);await rm(HOST,{recursive:true});await symlink(HOST+'-real',HOST);
  try{await assert.rejects(cmd('/bin/bash','/usr/local/libexec/agentx-worker-start'),'untrusted mount source refused');}
  finally{await unlink(HOST);await cmd('mv',HOST+'-real',HOST);}
  assert.equal(await lstat(ROOT+'/PLANTED-FIRED').then(()=>true,()=>false),false,'planted helper did not execute');
  // B2 isolates restore ordering from gateway networking qualification (which has its own CI step).
  const stage=repository+'/packages/worker/ec2/sandbox-egress.sh';
  for(const name of ['rovara-snet','rovara-xnet'])assert.equal(await cmd('docker','network','ls','--filter','name=^'+name+'$','--format','{{.Name}}'),'','disposable gateway networks required');
  await cmd('docker','network','create','--internal','--subnet','172.28.250.0/24','rovara-snet');gatewayOwned=true;
  await cmd('docker','network','create','--subnet','172.28.251.0/24','rovara-xnet');
  const gatewaySetup='set -euo pipefail\n'+settings+'BOOT_DEADLINE=$((SECONDS+480))\n. "'+stage+'"\nSE_DROPIN_WANT=fixture\n'+
    'se_daemon_dns_is(){ :; }; se_dropin_is(){ :; }; se_network_is(){ :; }; se_walls(){ :; }; se_restore_ports(){ :; };\n'+
    'se_gateway; se_gateway_running; se_install_restore_unit';
  await cmd('bash','-c',gatewaySetup);
  // Artificially slow restore so a missing ordering edge exposes the original race reliably.
  await writeFile('/usr/local/libexec/agentx-retention-restore',program().replace('initialize_close_retention '+scope[2],'sleep 5\ninitialize_close_retention '+scope[2]),{mode:0o700});
  await cmd('bash','-c',program());service=true;
  const args=await workerArguments();
  await resetRuntime();
  // This worker runs main.js from the real digest image, on a private network. Only awslogs/registry/IMDS are outside this local proof.
  const workerScript='/usr/local/libexec/close-retention-b1bis-worker-proof';
  const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
  await writeFile(workerScript,'#!/bin/bash\nset -euo pipefail\n[[ $(docker inspect --format "{{.State.Running}}" rovara-egw) == true ]] || { echo "gateway stopped at worker start" >&2; exit 1; }\nexec docker run --rm --name close-retention-b1bis-ready --network none --env AGENTX_SANDBOX_EGRESS=gateway --env AGENTX_SANDBOX_NETWORK=rovara-snet --env AGENTX_SANDBOX_DNS=172.28.250.2 --env AGENTX_DAEMON_PROXY=http://172.28.251.2:3128 '+args.map(quote).join(' ')+' '+quote(image)+'\n',{mode:0o700});
  const workerUnit='/etc/systemd/system/agentx-worker.service';
  let unit=await readFile(workerUnit,'utf8');unit=unit.replace('ExecStart=/usr/local/libexec/agentx-worker-start','ExecStart=/bin/bash '+workerScript).replace('Restart=always','Restart=no').replace(' rm --force agentx-worker\n',' rm --force close-retention-b1bis-ready\n').replace(' stop agentx-worker\n',' stop close-retention-b1bis-ready\n');
  await writeFile(workerUnit,unit);
  await cmd('systemctl','daemon-reload');await cmd('systemctl','reset-failed');
  await cmd('systemctl','start','agentx-worker.service');readyWorker='close-retention-b1bis-ready';
  try{
    for(let i=0;i<50;i++){if(await cmd('docker','ps','--all','--filter','name=^/close-retention-b1bis-ready$','--quiet'))break;await new Promise(r=>setTimeout(r,100));}
    assert.equal(await cmd('docker','inspect','--format','{{.State.Running}}','rovara-egw'),'true','gateway running at worker start');
    await waitReady(readyWorker,'legacy');
    assert.equal(await cmd('docker','exec',readyWorker,'node','--input-type=module','-e',"import {gatewayEgressFor} from './packages/worker/dist/task-sandbox.js';console.log(JSON.stringify(gatewayEgressFor()));"),JSON.stringify({network:'rovara-snet',dns:'172.28.250.2'}),'worker uses gateway mode');
    const previousServe=await cmd('systemctl','show','--property=InvocationID','--value','agentx-close-retention.service');
    assert.ok(previousServe,'serve invocation before Docker restart');
    await cmd('systemctl','restart','docker.service');
    const replacementServe=await cmd('systemctl','show','--property=InvocationID','--value','agentx-close-retention.service');
    assert.ok(replacementServe,'serve invocation after Docker restart');
    assert.notEqual(replacementServe,previousServe,'Docker restart replaces the previous serve unit');
    await waitReady(readyWorker,'legacy');
    assert.equal(await cmd('docker','inspect','--format','{{.State.Running}}','rovara-egw'),'true','gateway running after Docker restart');
  }finally{await cmd('systemctl','stop','agentx-worker.service');await cmd('docker','rm','--force',readyWorker).catch(()=>{});readyWorker=undefined;await rm(workerScript,{force:true});}
}finally{
  if(legacyProcess){legacyProcess.kill('SIGTERM');await once(legacyProcess,'exit').catch(()=>{});}
  if(events){events.kill('SIGTERM');await once(events,'exit').catch(()=>{});}
  if(readyWorker)await cmd('docker','rm','--force',readyWorker).catch(()=>{});
  if(gatewayOwned){await cmd('systemctl','stop','rovara-sandbox-egress.service').catch(()=>{});await cmd('docker','rm','--force','rovara-egw').catch(()=>{});for(const name of ['rovara-snet','rovara-xnet'])await cmd('docker','network','rm',name).catch(()=>{});await rm('/etc/systemd/system/rovara-sandbox-egress.service',{force:true});await rm('/etc/systemd/system/agentx-worker.service.d',{recursive:true,force:true});await rm('/usr/local/libexec/rovara-sandbox-egress-restore',{force:true});await rm('/var/lib/rovara-egress',{recursive:true,force:true});}
  if(task)await cmd('docker','rm','--force',task).catch(()=>{});
  if(maskVolumes.length)await cmd('docker','volume','rm',...maskVolumes).catch(()=>{});
  if(owned){await resetRuntime().catch(e=>console.error('proof teardown: resetRuntime failed',e.message));await cmd('umount',ROOT).catch(()=>{});await rm(ROOT,{recursive:true,force:true}).catch(e=>console.error('proof teardown: rm ROOT failed',e.message));}
  for(const p of ['/etc/agentx','/etc/systemd/system/agentx-worker.service','/etc/systemd/system/agentx-close-retention-restore.service','/usr/local/libexec/agentx-worker-start','/usr/local/libexec/agentx-retention-restore','/run/agentx-boot-failure'])await rm(p,{recursive:true,force:true});
  await cmd('systemctl','daemon-reload');
}
`;
