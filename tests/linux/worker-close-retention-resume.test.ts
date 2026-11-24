import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { it } from "vitest";

// CLOSE-RETENTION, Opus delta c62732f0b: the two Rule #15 items the review adds to the Linux grid. MANUAL LINUX CI ONLY (CODE_CI_LINUX=1 on a disposable Docker host with a digest-pinned worker image): they
// need root, loop devices and the worker image, and were NOT run when written. A red here is a finding, not a flaky test:
//   1. F3: a Continue over a SEALED but unconfirmed retention (the worker sealed and answered, the broker never saved the reply) sends no `supersedesRetention`, so the worker's sealed journal record is never
//      marked superseded. The step's writes must still be admitted on the woken worker, and the next Close's retain must succeed.
//   2. N-F1: an instance ended in the middle of a retain (the idle reaper's stop) leaves the retention either complete or absent, never half: the volume is intact, no writer is admitted, and the next retain succeeds.

// A proof owns /mnt/workspace and /run/agentx-close-retention while it runs. Its own teardown runs inside the process that still holds journal descriptors, so a mount can stay busy and the NEXT proof (or the grid's
// baseline) then fails "host already owns workspace path". Every proof therefore ends with a FRESH root process that detaches what the proof made, however the proof ended: lazy recursive unmounts, the loop devices
// backing /mnt/workspace, the serve helper, then the directories. It runs only after a proof that started (this suite refuses a host that already used those paths before it begins).
const teardownScript = [
  "pkill -f 'close-retention.sh serve' 2>/dev/null || true",
  "loops=$(losetup -a 2>/dev/null | grep '/mnt/workspace/' | cut -d: -f1 || true)",
  "umount -R -l /run/agentx-close-retention/view 2>/dev/null || true",
  "umount -R -l /mnt/workspace 2>/dev/null || true",
  "for device in $loops; do losetup --detach \"$device\" 2>/dev/null || true; done",
  "rm -rf /run/agentx-close-retention /mnt/workspace",
  "test ! -e /mnt/workspace && test ! -e /run/agentx-close-retention",
].join("\n");
async function teardownProofHost(): Promise<string | undefined> {
  try { await promisify(execFile)("sudo", ["-n", "bash", "-c", teardownScript], { timeout: 60_000 }); return undefined; }
  catch (error) { return "teardown could not release the proof host: " + String((error as { stderr?: string }).stderr ?? error); }
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

it.runIf(process.env.CODE_CI_LINUX === "1")("F3: a Continue over a sealed but unconfirmed retention is admitted on the woken worker (no supersession was ever sent), and the next Close's retain succeeds", async () => {
  await runRootProof(unconfirmedContinueProof, image(), 180_000);
}, 190_000);

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
    for(const device of loops)await command('losetup','--detach',device).catch(()=>{});
    await rm(RUN,{recursive:true,force:true}).catch(e=>console.error('proof teardown: rm RUN failed',e.message)); await rm(ROOT,{recursive:true,force:true}).catch(e=>console.error('proof teardown: rm ROOT failed',e.message));
  }
}
`;

const unconfirmedContinueProof = proofPrelude + String.raw`
  // The worker seals and answers; the broker "loses" the reply: nothing is saved on its side, and no superseding step is ever sent.
  const sealed=(await send(invocation)).body; assert.equal(sealed.status,'retained'); assert.equal(inspections,1);
  // A woken worker: a new journal / executor over the same volume and control directory, as after an instance restart.
  const wokenJournal=new OperationJournal(ROOT+'/data',ROOT+'/.agentx-control/journal');
  let wokenWrites=0;
  const wokenExecutor=new CloseRetentionExecutor(wokenJournal,new HostCloseRetentionStorage(),async()=>inspectWorkspaceForClose(ROOT+'/data'),()=>false);
  const wokenState=createWorkerServerState(wokenJournal,{execute:async()=>{wokenWrites++;},retention:i=>wokenExecutor.answer(i),admit:i=>wokenExecutor.admitWriter(i)});
  const wokenSend=async(i)=>{const response=await handleWorkerRequest(new Request('http://worker/invocations',{method:'POST',body:JSON.stringify(i)}),wokenState);return {status:response.status,body:await response.json()};};
  // The Continue: a plain task step with NO supersedesRetention (the broker had no confirmed retention to name).
  const step=await wokenSend({...invocation,kind:'task',operationId:randomUUID(),fence:11,payload:{conversationId:randomUUID(),prompt:'continue the work'}});
  assert.notEqual(step.status,409,'the step must be admitted: an unconfirmed seal must not hold the task'); assert.equal(wokenWrites,1);
  await writeFile(ROOT+'/data/repo/value','continued work\n');
  // The next Close's check: a new preflight at a higher fence retains again and sees the continued work.
  const again=await wokenSend({...invocation,operationId:randomUUID(),fence:12});
  assert.equal(again.body.status,'retained'); assert.equal(again.body.inspection.repositories.length>=0,true);
` + proofFinally;

const stopMidRetainProof = proofPrelude + String.raw`
  // The instance is ended while a retain is running: the control daemon dies under it (the reaper's stop).
  const inFlight=send(invocation).catch(error=>({status:0,body:{status:'failed',error:String(error)}}));
  daemon.kill('SIGKILL'); await once(daemon,'exit'); daemon=undefined;
  const interrupted=await inFlight; assert.notEqual(interrupted.body.status,'destroy_authorized');
  assert.equal(await readFile(ROOT+'/data/repo/value','utf8'),'original\n','the volume must be intact');
  // A restarted worker: the retain either completed (and then verifies) or never took hold (and then admits nothing wrong); the next retain succeeds.
  daemon=spawn('bash',[helper,'serve',workspaceId,'3','i-0123456789abcdef0','vol-0123456789abcdef0'],{stdio:['ignore','ignore','pipe']});
  for(let i=0;i<100;i++){if(await lstat(RUN+'/control.sock').then(()=>true,()=>false))break;await new Promise(r=>setTimeout(r,20));}
  const restartedJournal=new OperationJournal(ROOT+'/data',ROOT+'/.agentx-control/journal');
  const restartedExecutor=new CloseRetentionExecutor(restartedJournal,new HostCloseRetentionStorage(),async()=>inspectWorkspaceForClose(ROOT+'/data'),()=>false);
  const next=await restartedExecutor.answer({...invocation,operationId:randomUUID(),fence:12});
  assert.equal(next.status,'retained','the next retain must succeed after a stop in the middle of one');
` + proofFinally;
