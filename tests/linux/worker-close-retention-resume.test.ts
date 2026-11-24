import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { it } from "vitest";

// CLOSE-RETENTION, Opus delta c62732f0b: the two Rule #15 items the review adds to the Linux grid. MANUAL LINUX CI ONLY (CODE_CI_LINUX=1 on a disposable Docker host with a digest-pinned worker image): they
// need root, loop devices and the worker image, and were NOT run when written. A red here is a finding, not a flaky test:
//   1. F3 (decision: DONE.md): a Continue over a SEALED retention the broker never confirmed (the worker sealed and answered, the broker never saved the reply). A step without a selector is REFUSED; the dispatcher replays
//      the retain, the worker answers from its journal, and the step names that reply, so the worker's sealed journal record is
//      marked superseded. The step's writes must still be admitted on the woken worker, and the next Close's retain must succeed.
//   2. N-F1: an instance ended in the middle of a retain (the idle reaper's stop) leaves the retention either complete or absent, never half: the volume is intact, no writer is admitted, and the next retain succeeds.

// A kernel keeps a loop device's BLKROSET read-only flag after the device is detached, and `losetup --find` hands the same /dev/loopN to the next image: the next mount of a plain read-write image then comes up
// "source write-protected, mounted read-only". A real reboot clears it (a new kernel); a proof that emulates a reboot, or ends, in the same kernel must clear it itself: `blockdev --setrw` BEFORE the detach.

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
  try { await promisify(execFile)("sudo", ["-n", process.execPath, "--input-type=module", "-e", proof, resolve(import.meta.dirname, "../.."), image], { timeout, maxBuffer: 1_048_576 }); }
  catch (error) { failure = new Error((error as { stderr?: string }).stderr ?? "root proof failed without stderr", { cause: error }); }
  const leftover = await teardownProofHost();
  if (failure !== undefined) throw new Error(failure.message + (leftover === undefined ? "" : "\n" + leftover), { cause: failure.cause });
  if (leftover !== undefined) throw new Error(leftover);
}
const image = () => {
  const value = process.env.CLOSE_RETENTION_TEST_IMAGE;
  if (value === undefined || !/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/u.test(value)) throw new Error("manual proof needs an already-installed digest-pinned Linux worker image");
  return value;
};

it.runIf(process.env.CODE_CI_LINUX === "1")("F3: a Continue over a sealed retention the broker never confirmed: refused without its selector, admitted with the one a replayed retain returns, the volume writable, and the next Close's retain succeeds", async () => {
  await runRootProof(unconfirmedContinueProof, image(), 180_000);
}, 190_000);

it.runIf(process.env.CODE_CI_LINUX === "1")("F-A: an intent that newer work passed is retired in the journal, so the REBOOTED helper mounts the volume read-write, validate_boot passes after the generation rotates, and the admitted writer writes", async () => {
  await runRootProof(intentRebootProof, image(), 240_000);
}, 250_000);

it.runIf(process.env.CODE_CI_LINUX === "1")("N-F1: a worker ended in the middle of a retain leaves the retention complete or absent, the volume intact and no writer admitted, and the next retain succeeds", async () => {
  await runRootProof(stopMidRetainProof, image(), 180_000);
}, 190_000);

const proofPrelude = String.raw`
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
`;
const proofFinally = String.raw`
} finally {
  if(writer){writer.kill('SIGTERM');await once(writer,'exit').catch(()=>{});}
  if(container)await command('docker','rm','--force',container).catch(()=>{});
  if(daemon){daemon.kill('SIGTERM');await once(daemon,'exit').catch(()=>{});}
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

// F-A (Opus review 4eda07a26): the host helper reads the journal at BOOT, so the proof reboots: it runs the helper's own restore + validate_boot (`init`) over the journal the pass leaves, not a same-process worker.
const intentRebootProof = proofPrelude + String.raw`
  const helperArgs=[workspaceId,'3','i-0123456789abcdef0','vol-0123456789abcdef0'];
  const options=async()=>(await command('findmnt','-n','-o','OPTIONS','--target',ROOT+'/data')).split(',');
  // The control socket file of the previous serve outlives it: wait for a CONNECTION that works, not for the file.
  const serving=async()=>{for(let i=0;i<200;i++){try{await new HostCloseRetentionStorage().withOwnership('read',async()=>true);return;}catch{await new Promise(r=>setTimeout(r,25));}}throw new Error('the control socket never accepted a connection');};
  const startWorker=()=>{
    const j=new OperationJournal(ROOT+'/data',ROOT+'/.agentx-control/journal'), st=new HostCloseRetentionStorage();
    const ex=new CloseRetentionExecutor(j,st,async()=>inspectWorkspaceForClose(ROOT+'/data'),()=>false);
    const sv=createWorkerServerState(j,{execute:async()=>{},retention:i=>ex.answer(i),admit:i=>ex.admitWriter(i)});
    return {journal:j,send:async(i)=>{const response=await handleWorkerRequest(new Request('http://worker/invocations',{method:'POST',body:JSON.stringify(i)}),sv);return {status:response.status,body:await response.json()};}};
  };
  // The instance goes away and comes back: serve stopped, the data filesystem detached, then the helper's init (validate_boot + restore) and a new serve.
  const reboot=async()=>{
    daemon.kill('SIGTERM'); await once(daemon,'exit'); daemon=undefined;
    await command('umount','--recursive',RUN+'/view');
    // A real reboot drops EVERY mount and loop device of the old boot, the hidden older generations a hand-over stacked under DATA included: unmount all of them and detach every loop backed under the workspace.
    const attached=(await command('losetup','-a')).split('\n').filter(line=>line.includes(ROOT+'/')).map(line=>line.split(':')[0]);
    for(let i=0;i<8&&await command('mountpoint','-q',ROOT+'/data').then(()=>true,()=>false);i++)await command('umount',ROOT+'/data');
    for(const device of attached){await command('blockdev','--setrw',device).catch(()=>{});await command('losetup','--detach',device);}
    assert.equal(await command('bash',helper,'init',...helperArgs),'migrated','validate_boot and restore must accept the journal');
    daemon=spawn('bash',[helper,'serve',...helperArgs],{stdio:['ignore','ignore','pipe']});
    await serving();
  };
  // C1: a check whose seal is refused (an old writer holds the file) leaves an INTENT behind.
  writer=spawn('python3',['-u','-c','import sys,mmap; f=open(sys.argv[1],"r+b"); m=mmap.mmap(f.fileno(),0); print("ready",flush=True); sys.stdin.readline()',ROOT+'/data/repo/value'],{stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:writer.stdout})[Symbol.asyncIterator](); assert.equal((await lines.next()).value,'ready');
  assert.equal((await send(invocation)).body.status,'unavailable','an old mapping must prevent the seal');
  writer.stdin.end('stop\n'); await once(writer,'exit'); writer=undefined;
  // Reboot 1: the intent is unretired and its image was never made read-only: the volume comes back READ-WRITE (restore must not hold it).
  await reboot();
  assert.ok(!(await options()).includes('ro'),'an intent that never sealed must not mount the volume read-only');
  // The Continue passes the intent (no selector): admitted, the intent is retired, the writer writes.
  let worker=startWorker();
  const stepId=randomUUID();
  const step=await worker.send({...invocation,kind:'task',operationId:stepId,fence:11,payload:{conversationId:randomUUID(),prompt:'continue'}});
  assert.notEqual(step.status,409,'a never-answered intent must not hold the task');
  const retired=await worker.journal.get(invocation.operationId); assert.equal(retired.closeRetention.supersededBy,stepId,'the passed intent must be retired');
  await writeFile(ROOT+'/data/repo/value','continued work\n');
  await worker.journal.transition(stepId,'RUNNING').catch(()=>{}); await worker.journal.transition(stepId,'SUCCEEDED').catch(()=>{});
  // Reboot 2: validate_boot over the retired intent, then a check retains (C2) and its CONFIRMED hand-over rotates the generation.
  await reboot(); assert.ok(!(await options()).includes('ro'));
  worker=startWorker();
  const second=await worker.send({...invocation,operationId:randomUUID(),fence:12}); assert.equal(second.body.status,'retained');
  const handOver=await worker.send({...invocation,kind:'task',operationId:randomUUID(),fence:13,payload:{conversationId:randomUUID(),prompt:'more'},supersedesRetention:second.body.retention});
  assert.notEqual(handOver.status,409,'the confirmed hand-over must be admitted');
  const rotated=JSON.parse(await readFile(ROOT+'/.agentx-control/current.json','utf8')).generation.dataGeneration; assert.notEqual(rotated,generation.dataGeneration);
  // Reboot 3, AFTER the generation rotated: validate_boot must not trip over the retired intent of the old generation, and the new generation is writable.
  await reboot(); assert.ok(!(await options()).includes('ro'),'the successor generation is writable');
  await writeFile(ROOT+'/data/repo/value','after rotation\n');
` + proofFinally;

const unconfirmedContinueProof = proofPrelude + String.raw`
  // The worker seals and answers; the broker "loses" the reply: nothing is saved on its side, and no superseding step is ever sent.
  const sealed=(await send(invocation)).body; assert.equal(sealed.status,'retained'); assert.equal(inspections,1);
  // A woken worker: a new journal / executor over the same volume and control directory, as after an instance restart.
  const wokenJournal=new OperationJournal(ROOT+'/data',ROOT+'/.agentx-control/journal');
  let wokenWrites=0;
  const wokenExecutor=new CloseRetentionExecutor(wokenJournal,new HostCloseRetentionStorage(),async()=>inspectWorkspaceForClose(ROOT+'/data'),()=>false);
  const wokenState=createWorkerServerState(wokenJournal,{execute:async()=>{wokenWrites++;},retention:i=>wokenExecutor.answer(i),admit:i=>wokenExecutor.admitWriter(i)});
  const wokenSend=async(i)=>{const response=await handleWorkerRequest(new Request('http://worker/invocations',{method:'POST',body:JSON.stringify(i)}),wokenState);return {status:response.status,body:await response.json()};};
  // 1. A plain step (no selector) over a SEALED retention is refused: a sealed retention, answered or not, is released only by the step that names it.
  const plainStep=await wokenSend({...invocation,kind:'task',operationId:randomUUID(),fence:11,payload:{conversationId:randomUUID(),prompt:'continue the work'}});
  assert.equal(plainStep.status,409,'a sealed retention must not be released by a step that does not name it'); assert.equal(wokenWrites,0);
  // 2. The broker's takeover learns the worker's retention by REPLAYING the same retain: the worker answers from its journal (same reply, no new inspection), also on the woken instance.
  const replayed=await wokenSend(invocation); assert.equal(replayed.body.status,'retained'); assert.deepEqual(replayed.body.retention,sealed.retention);
  // 3. The Continue names that retention: it is admitted, gets a distinct generation, and the volume is writable.
  const stepId=randomUUID();
  const step=await wokenSend({...invocation,kind:'task',operationId:stepId,fence:11,payload:{conversationId:randomUUID(),prompt:'continue the work'},supersedesRetention:replayed.body.retention});
  assert.notEqual(step.status,409,'the step naming the retention must be admitted'); for(let i=0;i<100&&wokenWrites<1;i++)await new Promise(r=>setTimeout(r,20)); assert.equal(wokenWrites,1,'the admitted step must reach the executor');
  await writeFile(ROOT+'/data/repo/value','continued work\n');
  // 4. The next Close's check: a new preflight at a higher fence retains again and sees the continued work.
  await wokenJournal.transition(stepId,'RUNNING').catch(()=>{}); await wokenJournal.transition(stepId,'SUCCEEDED').catch(()=>{});
  // The hand-over rotated the generation: the next check targets the CURRENT one (a retain of the old target is a mismatch).
  const current=await new HostCloseRetentionStorage().identity(); assert.notEqual(current.dataGeneration,generation.dataGeneration);
  const again=await wokenSend({...invocation,operationId:randomUUID(),fence:12,payload:{schemaVersion:1,action:'retain',target:current}});
  assert.equal(again.body.status,'retained'); assert.equal(again.body.inspection.safeToClose,false,'the continued work is unpublished');
` + proofFinally;

const stopMidRetainProof = proofPrelude + String.raw`
  // The instance is ended while a retain is running: the control daemon dies under it (the reaper's stop).
  const inFlight=send(invocation).catch(error=>({status:0,body:{status:'failed',error:String(error)}}));
  daemon.kill('SIGKILL'); await once(daemon,'exit'); daemon=undefined;
  const interrupted=await inFlight; assert.notEqual(interrupted.body.status,'destroy_authorized');
  assert.equal(await readFile(ROOT+'/data/repo/value','utf8'),'original\n','the volume must be intact');
  // A restarted worker: the retain either completed (and then verifies) or never took hold (and then admits nothing wrong); the next retain succeeds.
  daemon=spawn('bash',[helper,'serve',workspaceId,'3','i-0123456789abcdef0','vol-0123456789abcdef0'],{stdio:['ignore','ignore','pipe']});
  for(let i=0;i<200;i++){try{await new HostCloseRetentionStorage().withOwnership('read',async()=>true);break;}catch{await new Promise(r=>setTimeout(r,25));}}
  const restartedJournal=new OperationJournal(ROOT+'/data',ROOT+'/.agentx-control/journal');
  const restartedExecutor=new CloseRetentionExecutor(restartedJournal,new HostCloseRetentionStorage(),async()=>inspectWorkspaceForClose(ROOT+'/data'),()=>false);
  const next=await restartedExecutor.answer({...invocation,operationId:randomUUID(),fence:12});
  assert.equal(next.status,'retained','the next retain must succeed after a stop in the middle of one');
` + proofFinally;
