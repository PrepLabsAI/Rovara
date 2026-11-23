import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { canonicalRetentionValue, CloseRetentionPayloadSchema, WorkspaceDataIdentitySchema } from "@agentx/contracts";
import { CloseJournalStateSchema } from "../../packages/worker/src/close-retention-storage.js";

const helper = readFileSync("packages/worker/ec2/close-retention.sh", "utf8");
const python = helper.split("<<'PY'\n")[1]?.split("\nPY")[0] ?? "";
const generation = { sessionGeneration: 3, instanceId: "i-0123456789abcdef0", volumeId: "vol-0123456789abcdef0", dataGeneration: "12345678-1234-4234-8234-123456789abc" };
const command = { schemaVersion: 1, action: "retain", target: generation };
const journal = { schemaVersion: 1, operationId: "12345678-1234-4234-8234-123456789abd", workspaceId: "12345678-1234-4234-8234-123456789abe", fence: 2, payloadHash: "a".repeat(64), status: "SUCCEEDED", acceptedAt: "2026-11-22T00:00:00.000Z", updatedAt: "2026-11-22T00:00:00.000Z", closeRetention: { schemaVersion: 1, commandHash: "a".repeat(64), generation, command, phase: "intent" } };

const hash = createHash("sha256").update(canonicalRetentionValue({ kind: "close", workspaceId: journal.workspaceId, operationId: journal.operationId, fence: journal.fence, payload: command })).digest("hex");
journal.payloadHash = hash; journal.closeRetention.commandHash = hash;
it("runs the real host parser and fd walks against bounded hostile control data", () => {
  expect(WorkspaceDataIdentitySchema.parse(generation)).toEqual(generation);
  expect(CloseRetentionPayloadSchema.parse(command)).toEqual(command);
  expect(CloseJournalStateSchema.parse(journal.closeRetention)).toEqual(journal.closeRetention);
  const program = python.slice(0, python.lastIndexOf("\nif sys.argv[1]")) + String.raw`
import tempfile, copy
fixture=json.loads(sys.argv[1]); gen=fixture['closeRetention']['generation']
manifest={'schemaVersion':1,'workspaceId':fixture['workspaceId'],'filesystemId':gen['dataGeneration'],'generation':gen}
LayoutManifestV1(manifest); ControlJournalV1(fixture)
def refuses(work):
    try: work()
    except (ValueError,OSError,UnicodeError,KeyError,TypeError,AttributeError,IndexError,OverflowError): return
    raise AssertionError('accepted invalid control data')
for raw in [b'[]',b'{"x":1,"x":2}',b'{"x":NaN}',b'{"x":Infinity}',b'{"x":-Infinity}',b'\xff',b'{"x":"\xff"}',b'{"x":'+b'['*33+b'0'+b']'*33+b'}']:
    refuses(lambda:parse_control_json(raw))
for key,value in [('schemaVersion',True),('workspaceId','../../root'),('filesystemId','/root'),('extra','x')]:
    bad=dict(manifest);bad[key]=value;refuses(lambda:LayoutManifestV1(bad))
for key,value in [('sessionGeneration',True),('sessionGeneration',0),('sessionGeneration',9007199254740992),('instanceId','i-123456789'),('volumeId','vol-../x'),('dataGeneration','/root')]:
    bad=copy.deepcopy(manifest);bad['generation'][key]=value;refuses(lambda:LayoutManifestV1(bad))
for key,value in [('schemaVersion',2),('fence',False),('operationId','../x'),('status','UNKNOWN'),('payloadHash','x'),('acceptedAt','yesterday'),('error','x'*4097),('path','/root')]:
    bad=dict(fixture);bad[key]=value;refuses(lambda:ControlJournalV1(bad))
bad=copy.deepcopy(fixture);bad['closeRetention']['command']['target']['dataGeneration']='../bad';refuses(lambda:ControlJournalV1(bad))
bad=copy.deepcopy(fixture);bad['closeRetention']['commandHash']='b'*64;refuses(lambda:ControlJournalV1(bad))
bad=copy.deepcopy(fixture);bad['closeRetention']['phase']='sealed';refuses(lambda:ControlJournalV1(bad))
tombstone={k:v for k,v in fixture.items() if k!='closeRetention'};tombstone.update(status='CANCELLED',payloadHash='cancelled-before-arrival');ControlJournalV1(tombstone)
# Every closed object, including full retained/destroy replies, keeps unknown fields out.
retained=copy.deepcopy(fixture)
retained['closeRetention'].update(phase='sealed',seal={'filesystemId':gen['dataGeneration'],'backingId':'1:2','deviceId':'7:0'})
proof={'inspectionOperationId':retained['operationId'],'inspectionFence':retained['fence'],'retentionId':gen['dataGeneration'],'contentDigest':'b'*64,'generation':gen}
retained['closeRetention']['terminalReply']={'schemaVersion':1,'workspaceId':retained['workspaceId'],'operationId':retained['operationId'],'fence':retained['fence'],'action':'retain','status':'retained','retention':proof,'inspection':{'safeToClose':False,'repositories':[{'name':'repo','reasons':['untracked_files']}],'contentDigest':'b'*64}}
destroy=copy.deepcopy(fixture);destroy['operationId']='12345678-1234-4234-8234-123456789abf';destroy['fence']=3
cmd={'schemaVersion':1,'action':'destroy','retention':proof,'effectId':'close:1','machineIds':['machine-1','machine-2']}
destroy['closeRetention']['command']=cmd;destroy['closeRetention']['phase']='destroy-authorized'
destroy['closeRetention']['terminalReply']={'schemaVersion':1,'workspaceId':destroy['workspaceId'],'operationId':destroy['operationId'],'fence':3,'action':'destroy','status':'destroy_authorized',**{k:cmd[k] for k in ('retention','effectId','machineIds')}}
def rehash(v):
    if 'closeRetention' not in v:return
    st=v['closeRetention'];c=copy.deepcopy(st['command'])
    if 'machineIds' in c and type(c['machineIds']) is list and all(type(x) is str for x in c['machineIds']):c['machineIds']=sorted(c['machineIds'])
    canonical={'kind':'close','workspaceId':v['workspaceId'],'operationId':v['operationId'],'fence':v['fence'],'payload':c}
    h=hashlib.sha256(json.dumps(canonical,sort_keys=True,separators=(',',':')).encode()).hexdigest();v['payloadHash']=h;st['commandHash']=h
rehash(destroy)
unsorted=copy.deepcopy(destroy);unsorted['closeRetention']['command']['machineIds'].reverse();ControlJournalV1(unsorted)
def dict_paths(v,path=()):
    if type(v) is dict:
        yield path
        for k,x in v.items():yield from dict_paths(x,path+(k,))
    elif type(v) is list:
        for k,x in enumerate(v):yield from dict_paths(x,path+(k,))
def at(v,path):
    for k in path:v=v[k]
    return v
for good,validate in [(manifest,LayoutManifestV1),(fixture,ControlJournalV1),(retained,ControlJournalV1),(destroy,ControlJournalV1),(tombstone,ControlJournalV1)]:
    validate(good)
    for path in dict_paths(good):
        bad=copy.deepcopy(good);at(bad,path)['unknownPath']='/etc/passwd';refuses(lambda:validate(bad))
for phase in ['intent','destroy-authorized']:
    bad=copy.deepcopy(retained);bad['closeRetention']['phase']=phase;refuses(lambda:ControlJournalV1(bad))
for key,value in [('workspaceId',gen['dataGeneration']),('operationId',gen['dataGeneration']),('fence',9)]:
    bad=copy.deepcopy(retained);bad['closeRetention']['terminalReply'][key]=value;refuses(lambda:ControlJournalV1(bad))
for key,value in [('schemaVersion',2),('generation',{**gen,'sessionGeneration':4}),('commandHash','c'*64),('supersededBy','../x')]:
    bad=copy.deepcopy(retained);bad['closeRetention'][key]=value;refuses(lambda:ControlJournalV1(bad))
for key,value in [('retentionId','../x'),('inspectionFence',0),('inspectionOperationId','/root'),('contentDigest','x')]:
    bad=copy.deepcopy(destroy);bad['closeRetention']['command']['retention'][key]=value;rehash(bad);refuses(lambda:ControlJournalV1(bad))
for machines in [[],['m']*2,['m']*9,['../x'],[True]]:
    bad=copy.deepcopy(destroy);bad['closeRetention']['command']['machineIds']=machines;rehash(bad);refuses(lambda:ControlJournalV1(bad))
for key,value in [('effectId','x'*257),('action','verify'),('schemaVersion',True)]:
    bad=copy.deepcopy(destroy);bad['closeRetention']['command'][key]=value;rehash(bad);refuses(lambda:ControlJournalV1(bad))
for key,value in [('schemaVersion',False),('fence',0),('fence',9007199254740992),('workspaceId','../x'),('operationId','../x'),('payloadHash','bad')]:
    bad=copy.deepcopy(tombstone);bad[key]=value;refuses(lambda:ControlJournalV1(bad))
for key,value in [('safeToClose',True),('repositories',[{'name':'../x','reasons':['untracked_files']}]),('repositories',[{'name':'repo','reasons':['unknown']}]),('contentDigest','a'*64)]:
    bad=copy.deepcopy(retained);bad['closeRetention']['terminalReply']['inspection'][key]=value;refuses(lambda:ControlJournalV1(bad))
for key,value in [('phase','unknown'),('generation',{**gen,'sessionGeneration':4})]:
    bad=copy.deepcopy(fixture);bad['closeRetention'][key]=value;refuses(lambda:ControlJournalV1(bad))
bad=copy.deepcopy(fixture);bad['closeRetention']['command']['target']['dataGeneration']='12345678-1234-4234-8234-123456789ab1';rehash(bad);refuses(lambda:ControlJournalV1(bad))
bad=copy.deepcopy(tombstone);bad['acceptedAt']='2026-11-22';refuses(lambda:ControlJournalV1(bad))
bad=copy.deepcopy(fixture);bad['payloadHash']='c'*64;bad['closeRetention']['commandHash']='c'*64;refuses(lambda:ControlJournalV1(bad))
bad=copy.deepcopy(fixture);bad['closeRetention']['phase']='destroy-authorized';refuses(lambda:ControlJournalV1(bad))
for key in ('backingId','deviceId'):
    bad=copy.deepcopy(retained);bad['closeRetention']['seal'][key]='../x';refuses(lambda:ControlJournalV1(bad))
bad=copy.deepcopy(retained);bad['closeRetention']['terminalReply']['inspection']['repositories']*=2;refuses(lambda:ControlJournalV1(bad))
for key,value in [('effectId','other'),('machineIds',['other'])]:
    bad=copy.deepcopy(destroy);bad['closeRetention']['terminalReply'][key]=value;refuses(lambda:ControlJournalV1(bad))
bad=copy.deepcopy(destroy);bad['closeRetention']['phase']='intent';refuses(lambda:ControlJournalV1(bad))
manifest_next={**manifest,'successorOperationId':gen['dataGeneration']};LayoutManifestV1(manifest_next)
bad={**manifest_next,'successorOperationId':'../x'};refuses(lambda:LayoutManifestV1(bad))
for extra in [{'supersedesRetention':proof},{'layoutMigration':{'schemaVersion':1,'phase':'intent','dataGeneration':gen['dataGeneration']}}]:
    good={**tombstone,**extra};ControlJournalV1(good)
    for path in dict_paths(good):
        bad=copy.deepcopy(good);at(bad,path)['unknownPath']='/root';refuses(lambda:ControlJournalV1(bad))
for migration in [{'schemaVersion':2,'phase':'intent','dataGeneration':gen['dataGeneration']},{'schemaVersion':1,'phase':'other','dataGeneration':gen['dataGeneration']},{'schemaVersion':1,'phase':'committed','dataGeneration':'../x'}]:refuses(lambda:ControlJournalV1({**tombstone,'layoutMigration':migration}))
refuses(lambda:ControlJournalV1({**tombstone,'supersedesRetention':{**proof,'retentionId':'../x'}}))
# Direct closed-schema parity for the existing payload/reply variants, even when journals never store them.
verify={'schemaVersion':1,'action':'verify','retention':proof,'queryId':gen['dataGeneration']}
base={'schemaVersion':1,'workspaceId':fixture['workspaceId'],'operationId':fixture['operationId'],'fence':2}
replies=[{**base,'action':'retain','status':'pending','target':gen},{**base,'action':'destroy','status':'pending',**{k:cmd[k] for k in ('retention','effectId','machineIds')}},{**base,'action':'verify','status':'verified','retention':proof,'queryId':gen['dataGeneration'],'verified':True},{**base,'action':'retain','status':'unavailable','reason':'busy'},retained['closeRetention']['terminalReply'],destroy['closeRetention']['terminalReply']]
for good,validate in [(command_value,command) for command_value in [fixture['closeRetention']['command'],cmd,verify]]+[(r,reply) for r in replies]:
    validate(good)
    for path in dict_paths(good):
        bad=copy.deepcopy(good);at(bad,path)['unknownPath']='/etc/passwd';refuses(lambda:validate(bad))
for bad in [{**verify,'queryId':'../x'},{**cmd,'effectId':'../x'},{**cmd,'machineIds':[]},{**fixture['closeRetention']['command'],'action':'bad'},{**cmd,'action':'bad'}]:refuses(lambda:command(bad))
for bad in [{**replies[2],'verified':1},{**replies[2],'queryId':'../x'},{**replies[3],'reason':'unknown'},{**replies[3],'action':'bad'},{**replies[0],'schemaVersion':True},{**replies[0],'operationId':'../x'},{**replies[0],'status':'bad'}]:refuses(lambda:reply(bad))
for bad in [[],['m','m'],['m']*9,['../x'],[True]]:refuses(lambda:machine_ids(bad))
for good,validate in [(proof,selector),(gen,generation)]:
    for key in good:
        bad=copy.deepcopy(good);bad[key]=False;refuses(lambda:validate(bad))
with tempfile.TemporaryDirectory() as temporary:
    root=os.path.realpath(temporary)
    ROOT=root; CONTROL=root+'/.agentx-control'; CURRENT=CONTROL+'/current.json'; JOURNAL=CONTROL+'/journal/.agentx/operations'
    journal_records.__defaults__=(JOURNAL,None)
    HOST_UID=os.getuid(); WORKER_UID=os.getuid(); os.mkdir(CONTROL,0o755)
    fd=os.open(CONTROL,os.O_RDONLY|os.O_DIRECTORY)
    try:
        exclusive_opens=[]
        def temporary_audit(event,args):
            if event=='open' and type(args[0]) is str and args[0].endswith('.tmp'):
                assert args[2]&os.O_EXCL and args[2]&os.O_NOFOLLOW, 'temporary control writes must be exclusive and nofollow'
                exclusive_opens.append(args[0])
        sys.addaudithook(temporary_audit)
        save(CURRENT,manifest);assert exclusive_opens;assert load_control_json(CURRENT,65536,LayoutManifestV1)==manifest;assert current()==manifest
        refuses(lambda:open_dir(CURRENT))
        p=CONTROL+'/bad.json'
        with open(p,'wb') as f:f.write(b' '*65537)
        os.chmod(p,0o600);refuses(lambda:load_control_json(p,65536,LayoutManifestV1))
        # A real writer changes size after the stat and before the data read; no stat/bytes are fabricated.
        fdopen=os.fdopen
        for before,after in [(json.dumps(manifest).encode(),json.dumps(manifest).encode()+b' '*65537),(json.dumps(manifest).encode()+b' '*65537,json.dumps(manifest).encode())]:
            with open(p,'wb') as f:f.write(before)
            def racing_fdopen(fd,*args,**kwargs):
                with open(p,'wb') as writer:writer.write(after)
                return fdopen(fd,*args,**kwargs)
            os.fdopen=racing_fdopen
            try:refuses(lambda:load_control_json(p,65536,LayoutManifestV1))
            finally:os.fdopen=fdopen
        os.unlink(p);os.symlink(CURRENT,p);refuses(lambda:load_control_json(p,65536,LayoutManifestV1))
        os.unlink(p);os.link(CURRENT,p);refuses(lambda:load_control_json(p,65536,LayoutManifestV1));os.unlink(p)
        os.mkfifo(p);refuses(lambda:load_control_json(p,65536,LayoutManifestV1));os.unlink(p)
        os.mkdir(CONTROL+'/bad-mode');os.chmod(CONTROL+'/bad-mode',0o777);refuses(lambda:open_dir(CONTROL+'/bad-mode'))
        os.mkdir(CONTROL+'/linked-target');os.symlink(CONTROL+'/linked-target',CONTROL+'/alias')
        refuses(lambda:save(CONTROL+'/alias/new.json',manifest))
        os.chmod(CONTROL,0o777);refuses(lambda:load_control_json(CURRENT,65536,LayoutManifestV1));os.chmod(CONTROL,0o755)
        for path in ['', 'relative','/../root',CONTROL+'/..',CONTROL+'/../outside']:refuses(lambda:open_dir(path))
        os.symlink(CURRENT,CONTROL+'/ownership.lock');refuses(lambda:open_regular(CONTROL+'/ownership.lock'));os.unlink(CONTROL+'/ownership.lock')
        os.symlink(CURRENT,p);before=open(CURRENT,'rb').read();refuses(lambda:save(p,manifest));assert open(CURRENT,'rb').read()==before;os.unlink(p)
        os.rename(CONTROL,CONTROL+'.old');os.mkdir(CONTROL,0o755)
        with open(CURRENT,'wb') as f:f.write(json.dumps(manifest).encode())
        os.chmod(CURRENT,0o600);refuses(lambda:load_control_json(CURRENT,65536,LayoutManifestV1));os.unlink(CURRENT);os.rmdir(CONTROL);os.rename(CONTROL+'.old',CONTROL)
        os.makedirs(JOURNAL,mode=0o700)
        assert migration_journals(fixture['workspaceId'],ROOT+'/absent')==[]
        plain={k:v for k,v in fixture.items() if k!='closeRetention'}
        args=[manifest['workspaceId'],str(gen['sessionGeneration']),gen['instanceId'],gen['volumeId']]
        assert validate_boot(*args)==manifest
        for index,value in [(0,gen['dataGeneration']),(1,'4'),(2,'i-12345678'),(3,'vol-12345678')]:
            bad=list(args);bad[index]=value;refuses(lambda:validate_boot(*bad))
        path=JOURNAL+'/'+fixture['operationId']+'.json'
        os.mkdir(JOURNAL+'/fences',0o700);current_fence=JOURNAL+'/fences/'+fixture['workspaceId']+'.json';save(current_fence,fixture['fence'])
        save(path,fixture);assert validate_boot(*args)==manifest
        mismatch={**plain,'operationId':str(uuid.uuid4())};save(path,mismatch);refuses(lambda:journal_records(JOURNAL));save(path,fixture)
        save(current_fence,1);refuses(lambda:validate_boot(*args));os.unlink(current_fence);refuses(lambda:validate_boot(*args));save(current_fence,fixture['fence'])
        bad=copy.deepcopy(fixture);bad['workspaceId']=gen['dataGeneration'];rehash(bad);save(path,bad);refuses(lambda:validate_boot(*args))
        bad=copy.deepcopy(fixture);bad['closeRetention']['generation']={**gen,'dataGeneration':'12345678-1234-4234-8234-123456789ab1'};bad['closeRetention']['command']['target']=bad['closeRetention']['generation'];rehash(bad);save(path,bad);refuses(lambda:validate_boot(*args))
        bad=copy.deepcopy(retained);bad['closeRetention']['seal']['filesystemId']='12345678-1234-4234-8234-123456789ab1';save(path,bad);refuses(lambda:validate_boot(*args))
        os.unlink(path)
        legacy=ROOT+'/.agentx/operations';os.makedirs(legacy,mode=0o700)
        one={**plain,'operationId':str(uuid.uuid4()),'fence':5,'status':'CANCELLED','payloadHash':'cancelled-before-arrival'}
        two={**plain,'operationId':str(uuid.uuid4()),'fence':2}
        save(legacy+'/'+one['operationId']+'.json',one);save(JOURNAL+'/'+two['operationId']+'.json',two)
        assert {r['operationId'] for r in migration_journals(fixture['workspaceId'],legacy)}=={one['operationId'],two['operationId']}
        save(JOURNAL+'/'+one['operationId']+'.json',{**one,'status':'FAILED','payloadHash':'c'*64});refuses(lambda:migration_journals(fixture['workspaceId'],legacy))
        save(JOURNAL+'/'+one['operationId']+'.json',{**one,'layoutMigration':{'schemaVersion':1,'phase':'intent','dataGeneration':gen['dataGeneration']}})
        merged=migration_journals(fixture['workspaceId'],legacy);assert len(merged)==2
        bad={**two,'workspaceId':gen['dataGeneration']};save(JOURNAL+'/'+two['operationId']+'.json',bad);refuses(lambda:migration_journals(fixture['workspaceId'],legacy));save(JOURNAL+'/'+two['operationId']+'.json',two)
        refuses(lambda:fence_values('../escape',()))
        refuses(lambda:journal_records(JOURNAL,[4096,0]));refuses(lambda:journal_records(JOURNAL,[0,64*1024*1024]))
        for directory in [legacy+'/fences',JOURNAL+'/fences']:os.makedirs(directory,mode=0o700,exist_ok=True)
        old_fence=legacy+'/fences/'+fixture['workspaceId']+'.json';new_fence=JOURNAL+'/fences/'+fixture['workspaceId']+'.json'
        save(old_fence,11);save(new_fence,7)
        ignored=JOURNAL+'/fences/ignored';open(ignored,'wb').close()
        assert migration_high_water(fixture['workspaceId'],legacy,merged)==11;os.unlink(ignored)
        assert load_control_json(old_fence,128,fence_number,False)==11
        for bad in [0,True,9007199254740992,{'schemaVersion':1},'12',12.5]:
            save(new_fence,bad);refuses(lambda:migration_high_water(fixture['workspaceId'],legacy,merged))
        save(new_fence,7);os.unlink(new_fence);os.symlink(old_fence,new_fence);refuses(lambda:migration_high_water(fixture['workspaceId'],legacy,merged));os.unlink(new_fence)
        foreign=JOURNAL+'/fences/'+gen['dataGeneration']+'.json';save(foreign,99);refuses(lambda:migration_high_water(fixture['workspaceId'],legacy,merged));os.unlink(foreign)
        with open(new_fence,'wb') as f:f.write(b'7'+b' '*128)
        os.chmod(new_fence,0o600);refuses(lambda:migration_high_water(fixture['workspaceId'],legacy,merged));os.unlink(new_fence)
        for i in range(4097):
            with open(JOURNAL+'/fences/ignored-'+str(i),'wb'):pass
        refuses(lambda:migration_high_water(fixture['workspaceId'],legacy,merged))
        for name in os.listdir(JOURNAL+'/fences'):os.unlink(JOURNAL+'/fences/'+name)
        os.unlink(old_fence);assert migration_high_water(fixture['workspaceId'],legacy,merged)==5
        assert migration_high_water(fixture['workspaceId'],legacy,[])==0
        for directory in [legacy,JOURNAL]:
            for name in os.listdir(directory):
                if name.endswith('.json'):os.unlink(directory+'/'+name)
        for i in range(4097):
            with open(JOURNAL+'/ignored-'+str(i),'wb'):pass
        refuses(lambda:journal_records(JOURNAL))
        for name in os.listdir(JOURNAL):
            if name.startswith('ignored-'):os.unlink(JOURNAL+'/'+name)
        invalid=JOURNAL+'/not-a-uuid.json'
        with open(invalid,'wb') as f:f.write(json.dumps(plain).encode())
        os.chmod(invalid,0o600);observed=[];watch=True
        def audit(event,args):
            if watch and event=='open' and args[0]=='not-a-uuid.json':observed.append(args[0])
        sys.addaudithook(audit)
        try:refuses(lambda:journal_records(JOURNAL));assert observed==[], 'invalid filenames must be rejected before open'
        finally:watch=False
        os.unlink(invalid)
        for i in range(4097):
            r={**plain,'operationId':str(uuid.uuid4())};save(JOURNAL+'/'+r['operationId']+'.json',r)
            if i==0:assert journal_records(JOURNAL)==[r]
        refuses(lambda:journal_records(JOURNAL))
        for name in os.listdir(JOURNAL):
            if name.endswith('.json'):os.unlink(JOURNAL+'/'+name)
        for i in range(17):
            r={**plain,'operationId':str(uuid.uuid4())};raw=json.dumps(r).encode();path=JOURNAL+'/'+r['operationId']+'.json'
            with open(path,'wb') as f:f.write(raw+b' '*(4*1024*1024-len(raw)))
            os.chmod(path,0o600)
        refuses(lambda:journal_records(JOURNAL))
        names=[name for name in os.listdir(JOURNAL) if name.endswith('.json')]
        for name in names[:8]:os.rename(JOURNAL+'/'+name,legacy+'/'+name)
        refuses(lambda:migration_journals(fixture['workspaceId'],legacy))
        os.chmod(CURRENT,0o666);refuses(lambda:load_control_json(CURRENT,65536,LayoutManifestV1))
    finally:os.close(fd)
print('host-parser-pass')
`;
  const result = spawnSync("python3", ["-c", program, JSON.stringify(journal)], { encoding: "utf8", timeout: 10_000 });
  expect(result.stderr).toBe(""); expect(result.status).toBe(0); expect(result.stdout).toContain("host-parser-pass");
});
