#!/bin/bash
# Executed only from the digest-checked host tmpfs copy. The volume contains data.
set -euo pipefail
umask 077
if [[ ${1:-} == install ]]; then
  shift
  readonly HOST_RUN=/run/agentx-close-retention-host
  readonly RUN=/run/agentx-close-retention
  serve_state=$(systemctl show --property=LoadState --value agentx-close-retention.service)
  if [[ "$serve_state" != not-found ]]; then
    systemctl stop agentx-close-retention.service
  fi
  layout=$(/bin/bash "$HOST_RUN/helper.sh" init "$@")
  [[ "$layout" == migrated || "$layout" == legacy ]] || exit 1
  mount --bind /mnt/workspace/.agentx-control/journal "$RUN/journal"
  mount -o remount,bind,rw,nodev,nosuid,noexec "$RUN/journal"
  mount --make-rprivate "$RUN/journal"
  mounts_tmp=$(mktemp "$HOST_RUN/mounts.XXXXXX")
  cat >"$mounts_tmp" <<'MOUNTS'
[[ -S /run/agentx-close-retention/control.sock ]] || return 1
MOUNTS
  if [[ "$layout" == migrated ]]; then
    printf '%s\n' 'args+=(--mount type=bind,src=/run/agentx-close-retention/journal,dst=/mnt/agentx-control,bind-propagation=rprivate --env AGENTX_CONTROL_ROOT=/mnt/agentx-control)' >>"$mounts_tmp"
    printf '%s\n' 'args+=(--volume "/run/agentx-close-retention/view:$MOUNT_PATH:rslave" --env AGENTX_WORKSPACE_ROOT=/mnt/workspace/data)' >>"$mounts_tmp"
  else
    printf '%s\n' 'args+=(--volume "$MOUNT_PATH:$MOUNT_PATH")' >>"$mounts_tmp"
  fi
  printf '%s\n' 'args+=(--volume /run/agentx-close-retention:/run/agentx-close-retention:rslave)' >>"$mounts_tmp"
  chmod 0444 "$mounts_tmp"
  mv -fT "$mounts_tmp" "$HOST_RUN/worker-mounts"
  systemd-run --unit=agentx-close-retention --collect --property=Restart=on-failure /bin/bash "$HOST_RUN/helper.sh" serve "$@" >/dev/null
  for attempt in {1..50}; do [[ ! -S "$RUN/control.sock" ]] || exit 0; sleep 0.1; done
  exit 1
fi
exec python3 - "$@" <<'PY'
import datetime, hashlib, fcntl, glob, json, os, re, shutil, socketserver, stat, subprocess, sys, uuid
ROOT='/mnt/workspace'; CONTROL=ROOT+'/.agentx-control'; DATA=ROOT+'/data'
CURRENT=CONTROL+'/current.json'; JOURNAL=CONTROL+'/journal/.agentx/operations'
RUN='/run/agentx-close-retention'; VIEW=RUN+'/view'
UUID=re.compile(r'^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$',re.I)
def run(*args): return subprocess.check_output(args,text=True,timeout=120).strip()
HOST_UID=0; WORKER_UID=1000
CONTROL_FD=None
HASH=re.compile(r'^[a-f0-9]{64}$')
def require(ok):
    if not ok: raise ValueError('invalid control state; explicit recovery required')
def fields(v,required,optional=()):
    require(type(v) is dict and set(required)<=set(v)<=set(required)|set(optional))
def text(v,pattern): require(type(v) is str and re.fullmatch(pattern,v) is not None)
def positive(v): require(type(v) is int and 0<v<=9007199254740991)
def version(v): require(type(v) is int and v==1)
def uid(v): require(type(v) is str and UUID.fullmatch(v) is not None)
def generation(v):
    fields(v,('sessionGeneration','instanceId','volumeId','dataGeneration')); positive(v['sessionGeneration'])
    text(v['instanceId'],r'i-(?:[a-f0-9]{8}|[a-f0-9]{17})'); text(v['volumeId'],r'vol-(?:[a-f0-9]{8}|[a-f0-9]{17})'); uid(v['dataGeneration'])
def LayoutManifestV1(v):
    fields(v,('schemaVersion','workspaceId','filesystemId','generation'),('successorOperationId',)); version(v['schemaVersion'])
    uid(v['workspaceId']); uid(v['filesystemId']); generation(v['generation'])
    if 'successorOperationId' in v: uid(v['successorOperationId'])
    return v
def selector(v):
    fields(v,('inspectionOperationId','inspectionFence','retentionId','contentDigest','generation'))
    uid(v['inspectionOperationId']); positive(v['inspectionFence']); uid(v['retentionId']); text(v['contentDigest'],HASH.pattern); generation(v['generation'])
def machine_ids(v):
    require(type(v) is list and 1<=len(v)<=8 and all(type(x) is str for x in v) and len(set(v))==len(v))
    for x in v: text(x,r'[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}')
def command(v):
    fields(v,('schemaVersion','action'),('target','retention','queryId','effectId','machineIds')); version(v['schemaVersion'])
    a=v['action']; require(a in ('retain','verify','destroy'))
    if a=='retain': fields(v,('schemaVersion','action','target')); generation(v['target'])
    else:
        selector(v['retention'])
        if a=='verify': fields(v,('schemaVersion','action','retention','queryId')); uid(v['queryId'])
        else:
            fields(v,('schemaVersion','action','retention','effectId','machineIds')); text(v['effectId'],r'[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}'); machine_ids(v['machineIds'])
def inspection(v):
    fields(v,('safeToClose','repositories','contentDigest')); text(v['contentDigest'],HASH.pattern)
    repos=v['repositories']; require(type(repos) is list and len(repos)<=32 and type(v['safeToClose']) is bool and v['safeToClose']==(len(repos)==0))
    names=[]
    for r in repos:
        fields(r,('name','reasons')); text(r['name'],r'[a-z][a-z0-9-]{0,62}'); names.append(r['name'])
        reasons=r['reasons']; require(type(reasons) is list and 1<=len(reasons)<=4 and all(type(x) is str for x in reasons) and len(set(reasons))==len(reasons) and set(reasons)<={'worktree_changes','untracked_files','unpushed_head','unpushed_branch'})
    require(len(set(names))==len(names))
def reply(v):
    base=('schemaVersion','workspaceId','operationId','fence','action','status')
    version(v['schemaVersion']); uid(v['workspaceId']); uid(v['operationId']); positive(v['fence'])
    a=v['action']; s=v['status']; require(a in ('retain','verify','destroy'))
    if s=='unavailable': fields(v,base+('reason',)); require(v['reason'] in ('busy','unsupported','unproven','mismatch'))
    elif a=='retain' and s=='pending': fields(v,base+('target',)); generation(v['target'])
    elif a=='retain' and s=='retained':
        fields(v,base+('retention','inspection')); selector(v['retention']); inspection(v['inspection'])
        require(v['retention']['contentDigest']==v['inspection']['contentDigest'] and v['retention']['inspectionOperationId']==v['operationId'] and v['retention']['inspectionFence']==v['fence'])
    elif a=='verify' and s=='verified': fields(v,base+('retention','queryId','verified')); selector(v['retention']); uid(v['queryId']); require(type(v['verified']) is bool)
    else:
        require(a=='destroy' and s in ('pending','destroy_authorized')); fields(v,base+('retention','effectId','machineIds')); selector(v['retention']); text(v['effectId'],r'[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}'); machine_ids(v['machineIds'])
def ControlJournalV1(v):
    fields(v,('schemaVersion','operationId','workspaceId','fence','payloadHash','status','acceptedAt','updatedAt'),('error','closeRetention','supersedesRetention','layoutMigration'))
    version(v['schemaVersion']); uid(v['operationId']); uid(v['workspaceId']); positive(v['fence'])
    require(v['status'] in ('ACCEPTED','RUNNING','SUCCEEDED','FAILED','CANCELLED','INTERRUPTED'))
    require(type(v['payloadHash']) is str and (HASH.fullmatch(v['payloadHash']) is not None or (v['payloadHash']=='cancelled-before-arrival' and v['status']=='CANCELLED')))
    for key in ('acceptedAt','updatedAt'):
        text(v[key],r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z'); datetime.datetime.fromisoformat(v[key].replace('Z','+00:00'))
    if 'error' in v: require(type(v['error']) is str and len(v['error'])<=4096 and '\x00' not in v['error'])
    if 'supersedesRetention' in v: selector(v['supersedesRetention'])
    if 'layoutMigration' in v:
        m=v['layoutMigration']; fields(m,('schemaVersion','phase','dataGeneration')); version(m['schemaVersion']); uid(m['dataGeneration']); require(m['phase'] in ('intent','committed'))
    if 'closeRetention' in v:
        s=v['closeRetention']; fields(s,('schemaVersion','commandHash','generation','command','phase'),('seal','terminalReply','supersededBy'))
        version(s['schemaVersion']); text(s['commandHash'],HASH.pattern); generation(s['generation']); command(s['command'])
        require(s['command']['action'] in ('retain','destroy') and s['phase'] in ('intent','sealed','destroy-authorized') and s['commandHash']==v['payloadHash'])
        target=s['command'].get('target',s['command'].get('retention',{}).get('generation')); require(s['generation']==target)
        c=dict(s['command'])
        if 'machineIds' in c: c['machineIds']=sorted(c['machineIds'])
        canonical={'kind':'close','workspaceId':v['workspaceId'],'operationId':v['operationId'],'fence':v['fence'],'payload':c}
        require(hashlib.sha256(json.dumps(canonical,sort_keys=True,separators=(',',':')).encode()).hexdigest()==s['commandHash'])
        if 'seal' in s:
            fields(s['seal'],('filesystemId','backingId','deviceId')); uid(s['seal']['filesystemId'])
            for key in ('backingId','deviceId'): text(s['seal'][key],r'\d+:\d+')
        require(s['phase']!='sealed' or ('seal' in s and s['command']['action']=='retain'))
        require(s['phase']!='destroy-authorized' or s['command']['action']=='destroy')
        if 'supersededBy' in s: uid(s['supersededBy']); require(s['phase']=='sealed' or (s['phase']=='intent' and 'seal' not in s and 'terminalReply' not in s))
        if 'terminalReply' in s:
            r=s['terminalReply']; reply(r)
            require(all(r[k]==v[k] for k in ('workspaceId','operationId','fence')) and r['action']==s['command']['action'])
            if r['status']=='retained': require(s['phase']=='sealed' and 'seal' in s and r['retention']['generation']==s['generation'])
            else: require(r['status']=='destroy_authorized' and s['phase']=='destroy-authorized' and all(r[k]==s['command'][k] for k in ('retention','effectId')) and sorted(r['machineIds'])==sorted(s['command']['machineIds']))
    return v
def parse_control_json(raw,object_root=True):
    def pairs(items):
        result={}
        for k,v in items:
            require(k not in result); result[k]=v
        return result
    def constant(_): raise ValueError('non-finite JSON')
    v=json.loads(raw.decode('utf-8','strict'),object_pairs_hook=pairs,parse_constant=constant)
    def depth(x,n):
        require(n<=32)
        if type(x) is dict:
            for child in x.values(): depth(child,n+1)
        elif type(x) is list:
            for child in x: depth(child,n+1)
    depth(v,0); require(not object_root or type(v) is dict); return v

def open_dir(path):
    global CONTROL_FD
    require(os.path.isabs(path) and '\x00' not in path and all(x not in ('.','..') for x in path.split('/')))
    cached=CONTROL_FD is not None and (path==CONTROL or path.startswith(CONTROL+'/'))
    fd=os.dup(CONTROL_FD) if cached else os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    try:
        current=CONTROL if cached else ''
        parts=path[len(CONTROL):].split('/') if cached else path.split('/')
        for part in parts:
            if not part: continue
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd); os.close(fd); fd=child; current+='/'+part
            s=os.fstat(fd)
            if current==CONTROL or current.startswith(CONTROL+'/') or current==ROOT+'/.agentx' or current.startswith(ROOT+'/.agentx/'):
                require(s.st_uid in ((HOST_UID,WORKER_UID) if current==CONTROL+'/journal' or current.startswith(CONTROL+'/journal/') or current==ROOT+'/.agentx' or current.startswith(ROOT+'/.agentx/') else (HOST_UID,)) and not s.st_mode&0o022 and s.st_dev==os.stat(ROOT).st_dev)
                if current==CONTROL and CONTROL_FD is None: CONTROL_FD=os.dup(fd)
        if cached:
            expected=os.fstat(CONTROL_FD); actual=os.lstat(CONTROL)
            require(expected.st_uid==HOST_UID and not expected.st_mode&0o022)
            require((expected.st_dev,expected.st_ino)==(actual.st_dev,actual.st_ino) and not stat.S_ISLNK(actual.st_mode))
        return fd
    except BaseException: os.close(fd); raise

def open_regular(path,flags=os.O_RDONLY,mode=0o600):
    parent=open_dir(os.path.dirname(path))
    try:
        fd=os.open(os.path.basename(path),flags|os.O_NOFOLLOW|os.O_NONBLOCK,mode,dir_fd=parent)
        try:
            s=os.fstat(fd); require(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid in ((HOST_UID,WORKER_UID) if path.startswith(CONTROL+'/journal/') or path.startswith(ROOT+'/.agentx/') else (HOST_UID,)) and not s.st_mode&0o022)
            return fd
        except BaseException: os.close(fd); raise
    finally: os.close(parent)
def load_control_json(path,limit,validator,object_root=True):
    fd=open_regular(path)
    try:
        require(os.fstat(fd).st_size<=limit)
        with os.fdopen(os.dup(fd),'rb') as f: raw=f.read(limit+1)
        require(len(raw)<=limit); return validator(parse_control_json(raw,object_root))
    finally: os.close(fd)
def syncdir(path):
    fd=open_dir(path)
    try: os.fsync(fd)
    finally: os.close(fd)
def save(path,value):
    parent=open_dir(os.path.dirname(path)); temporary=str(uuid.uuid4())+'.tmp'
    try:
        fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=parent)
        with os.fdopen(fd,'wb') as f: f.write(json.dumps(value,separators=(',',':')).encode()); f.flush(); os.fsync(f.fileno())
        try:
            old=os.stat(os.path.basename(path),dir_fd=parent,follow_symlinks=False); require(stat.S_ISREG(old.st_mode) and old.st_nlink==1)
        except FileNotFoundError: pass
        os.replace(temporary,os.path.basename(path),src_dir_fd=parent,dst_dir_fd=parent); os.fsync(parent)
    finally:
        try: os.unlink(temporary,dir_fd=parent)
        except FileNotFoundError: pass
        os.close(parent)
def protected(path,directory=False):
    os.close(open_dir(path) if directory else open_regular(path))
def journal_records(directory=JOURNAL,budget=None):
    fd=open_dir(directory)
    try:
        names=[]; result=[]; count=0
        if budget is None: budget=[0,0]
        with os.scandir(fd) as entries:
            for entry in entries:
                count+=1; require(count<=4096)
                if entry.name.endswith('.json'): names.append(entry.name)
        for name in sorted(names):
            uid(name[:-5]); path=directory+'/'+name
            budget[0]+=1; budget[1]+=os.stat(name,dir_fd=fd,follow_symlinks=False).st_size
            require(budget[0]<=4096 and budget[1]<=64*1024*1024)
            r=load_control_json(path,4*1024*1024,ControlJournalV1); require(r['operationId']==name[:-5]); result.append(r)
        return result
    finally: os.close(fd)
def reject_control_mount_aliases():
    with open('/proc/self/mountinfo') as f:
        for line in f:
            mount=line.split()[4].replace('\\040',' ').replace('\\134','\\')
            require(all(mount!=root and not mount.startswith(root+'/') for root in (CONTROL,ROOT+'/.agentx')))
def current():
    return load_control_json(CURRENT,65536,LayoutManifestV1)
def ensure_dir(path,owner=HOST_UID,mode=0o700):
    parent=open_dir(os.path.dirname(path))
    try:
        try: os.mkdir(os.path.basename(path),mode,dir_fd=parent)
        except FileExistsError: pass
        child=os.open(os.path.basename(path),os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
        try:
            info=os.fstat(child); require(info.st_uid in (HOST_UID,owner) and not info.st_mode&0o022 and info.st_dev==os.stat(ROOT).st_dev)
            os.fchown(child,owner,owner); os.fchmod(child,mode)
        finally: os.close(child)
    finally: os.close(parent)
def copy_regular(source,destination):
    source_fd=open_regular(source); target_fd=None
    try:
        target_fd=open_regular(destination,os.O_WRONLY|os.O_CREAT|os.O_EXCL)
        subprocess.run(['cp','--reflink=auto','--sparse=always','--','/proc/self/fd/'+str(source_fd),'/proc/self/fd/'+str(target_fd)],check=True,timeout=120,pass_fds=(source_fd,target_fd))
        os.fsync(target_fd)
    finally:
        os.close(source_fd)
        if target_fd is not None: os.close(target_fd)
def image(value): return CONTROL+'/generations/'+value['generation']['dataGeneration']+'.ext4'
def data_directory():
    fd=open_dir(DATA)
    try: require(os.fstat(fd).st_uid in (HOST_UID,WORKER_UID))
    finally: os.close(fd)
def mountinfo():
    m=json.loads(run('findmnt','--json','--target',DATA,'--output','TARGET,SOURCE,FSTYPE,OPTIONS,MAJ:MIN,UUID'))['filesystems'][-1]
    if m['target']!=DATA or m['fstype']!='ext4' or not re.fullmatch(r'/dev/loop[0-9]+',m['source']): raise ValueError('unknown data mount')
    if 'noatime' not in m['options'].split(','): raise ValueError('data mount can update metadata on reads')
    return m
def identity(value):
    m=mountinfo(); backing=image(value); protected(backing)
    loops=json.loads(run('losetup','--json','--associated',backing,'--output','NAME,BACK-FILE,RO'))['loopdevices']
    if len(loops)!=1 or loops[0]['name']!=m['source'] or os.path.realpath(loops[0]['back-file'])!=backing or m['uuid']!=value['filesystemId']: raise ValueError('backing identity changed')
    s=os.stat(backing)
    return m,loops[0],{'filesystemId':m['uuid'],'backingId':str(s.st_dev)+':'+str(s.st_ino),'deviceId':m['maj:min']}
def sealed(value):
    m,loop,result=identity(value)
    if 'ro' not in m['options'].split(',') or not loop['ro'] or run('blockdev','--getro',m['source'])!='1': raise ValueError('kernel seal missing')
    for path in glob.glob('/proc/[0-9]*/mountinfo'):
        try:
            with open(path) as f: lines=f.readlines()
        except (FileNotFoundError,ProcessLookupError): continue
        for line in lines:
            fields=line.split(); split=fields.index('-')
            if fields[2]==m['maj:min'] and 'rw' in fields[split+3].split(','): raise ValueError('writable mount alias')
    return result
def record(operation_id):
    if not UUID.fullmatch(operation_id): raise ValueError('invalid operation identity')
    r=load_control_json(JOURNAL+'/'+operation_id+'.json',4*1024*1024,ControlJournalV1)
    if r['operationId']!=operation_id or r['workspaceId']!=current()['workspaceId']: raise ValueError('wrong journal scope')
    return r
def retained_command(operation_id):
    r=record(operation_id); value=current(); state=r['closeRetention']
    if state['schemaVersion']!=1 or state['generation']!=value['generation']: raise ValueError('generation mismatch')
    return r,value

def refuse_writers(value):
    m,_,_=identity(value); device=os.stat(DATA).st_dev; backing=os.stat(image(value))
    for process in glob.glob('/proc/[0-9]*'):
        try:
            for path in glob.glob(process+'/fd/*'):
                try:
                    s=os.stat(path)
                    if s.st_dev!=device and (s.st_dev,s.st_ino)!=(backing.st_dev,backing.st_ino): continue
                    with open(process+'/fdinfo/'+os.path.basename(path)) as f: flags=next(line for line in f if line.startswith('flags:'))
                    if int(flags.split()[1],8)&3: raise ValueError('open writable descriptor')
                except (FileNotFoundError,ProcessLookupError): continue
            with open(process+'/maps') as f:
                for line in f:
                    fields=line.split()
                    if len(fields)<5 or not fields[1].startswith('rw') or not fields[1].endswith('s') or int(fields[4])==0: continue
                    major,minor=(int(x,16) for x in fields[3].split(':'))
                    if os.makedev(major,minor)==device: raise ValueError('shared writable mapping')
        except (FileNotFoundError,ProcessLookupError): continue
    for container_id in run('docker','ps','--all','--quiet').splitlines():
        for container in json.loads(run('docker','inspect',container_id)):
            if container.get('Name')=='/agentx-worker': continue
            if any(x.get('Source','')==DATA or x.get('Source','').startswith(DATA+'/') for x in container.get('Mounts',[])): raise ValueError('unconfirmed container writer')
    return m

def seal(operation_id):
    r,value=retained_command(operation_id)
    if r['closeRetention']['command']['action']!='retain': raise ValueError('retain intent required')
    m=refuse_writers(value); run('sync','-f',DATA)
    run('mount','-o','remount,ro,noatime',DATA); run('blockdev','--setro',m['source'])
    os.chmod(image(value),0o400); syncdir(CONTROL+'/generations')
    return sealed(value)
def publish_view(value):
    prepare_run()
    if not os.path.ismount(VIEW):
        os.makedirs(VIEW,mode=0o755,exist_ok=True); os.chmod(VIEW,0o755); run('mount','-t','tmpfs','-o','mode=755','tmpfs',VIEW); run('mount','--make-rshared',VIEW)
        os.mkdir(VIEW+'/data',0o755); os.chmod(VIEW+'/data',0o755)
    run('mount','--bind',DATA,VIEW+'/data')
    save(RUN+'/current.json',value); os.chmod(RUN+'/current.json',0o444)
def restore():
    value=current(); protected(image(value)); data_directory(); held=False
    for path in journal_records():
        state=path.get('closeRetention')
        if state and not state.get('supersededBy'):
            if state.get('schemaVersion')!=1: raise ValueError('unknown retention state')
            held=held or not (state.get('phase')=='intent' and 'seal' not in state and 'terminalReply' not in state and os.stat(image(value)).st_mode&0o200)
    if not os.path.ismount(DATA):
        if held and 'needs_recovery' in run('tune2fs','-l',image(value)): raise ValueError('uncertain seal requires explicit recovery')
        device=run('losetup','--find','--show',*(['--read-only'] if held else []),image(value))
        run('mount','-t','ext4','-o','ro,noload,noatime' if held else 'rw,noatime',device,DATA)
    if held: sealed(value)
    os.chown(ROOT,0,0); os.chmod(ROOT,0o755); publish_view(value)
def validate_boot(workspace,generation_number,instance,volume):
    value=current(); g=value['generation']
    require(value['workspaceId']==workspace and g['sessionGeneration']==int(generation_number) and g['instanceId']==instance and g['volumeId']==volume)
    records=journal_records()
    require(max(fence_values(workspace,(JOURNAL+'/fences',))+[0])>=max([r['fence'] for r in records]+[0]))
    for r in records:
        require(r['workspaceId']==workspace)
        state=r.get('closeRetention')
        if state and not state.get('supersededBy'):
            require(state['generation']==g)
            if state['phase']=='sealed': require(state['seal']['filesystemId']==value['filesystemId'])
    return value
def prepare_run():
    for path,mode,owners in ((RUN,0o750,(HOST_UID,)),(RUN+'/journal',0o700,(HOST_UID,WORKER_UID))):
        if not os.path.lexists(path):
            os.mkdir(path,mode); os.chmod(path,mode)
        info=os.lstat(path)
        require(stat.S_ISDIR(info.st_mode) and info.st_uid in owners and stat.S_IMODE(info.st_mode)==mode)
    os.chown(RUN,0,1000)
def migration_journals(workspace,legacy):
    result={}; budget=[0,0]
    for directory in (legacy,JOURNAL):
        if not os.path.lexists(directory): continue
        for r in journal_records(directory,budget):
            require(r['workspaceId']==workspace)
            old=result.get(r['operationId'])
            if old is not None:
                require({k:v for k,v in old.items() if k!='layoutMigration'}=={k:v for k,v in r.items() if k!='layoutMigration'})
            result[r['operationId']]=r
    return [result[key] for key in sorted(result)]
def fence_number(value):
    positive(value); return value
def fence_values(workspace,directories):
    uid(workspace); values=[]
    for directory in directories:
        if not os.path.lexists(directory): continue
        fd=open_dir(directory)
        try:
            count=0
            with os.scandir(fd) as entries:
                for entry in entries:
                    count+=1; require(count<=4096)
                    if not entry.name.endswith('.json'): continue
                    require(entry.name==workspace+'.json')
                    values.append(load_control_json(directory+'/'+entry.name,128,fence_number,False))
        finally: os.close(fd)
    return values
def migration_high_water(workspace,legacy,records):
    return max([r['fence'] for r in records]+fence_values(workspace,(legacy+'/fences',JOURNAL+'/fences'))+[0])
def migrate(workspace,generation,instance,volume):
    uid(workspace); text(generation,r'[1-9][0-9]*'); positive(int(generation))
    text(instance,r'i-(?:[a-f0-9]{8}|[a-f0-9]{17})'); text(volume,r'vol-(?:[a-f0-9]{8}|[a-f0-9]{17})')
    running=bool(run('docker','ps','--quiet'))
    if os.path.lexists(CURRENT):
        if running: raise ValueError('restore requires quiescence')
        value=validate_boot(workspace,generation,instance,volume)
        expected=dict(value['generation'],sessionGeneration=int(generation),instanceId=instance,volumeId=volume)
        if value['workspaceId']!=workspace or expected!=value['generation']: raise ValueError('machine replacement requires explicit recovery')
        restore(); return 'migrated'
    legacy=ROOT+'/.agentx/operations'
    records=migration_journals(workspace,legacy)
    high_water=migration_high_water(workspace,legacy,records)
    for r in records: require(r['workspaceId']==workspace)
    if any(r.get('closeRetention') for r in records): raise ValueError('retained operation requires explicit recovery')
    legacy_only=running or bool(run('docker','ps','--all','--quiet')) or os.path.lexists(DATA) or any(r['status'] not in ('SUCCEEDED','FAILED','CANCELLED','INTERRUPTED') for r in records)
    exclusions={'.agentx-control','.agentx-runtime','.docker','data','lost+found'}
    for path in glob.glob('/proc/[0-9]*/fd/*')+glob.glob('/proc/[0-9]*/cwd'):
        try: target=os.readlink(path)
        except (FileNotFoundError,ProcessLookupError): continue
        if target.startswith(ROOT+'/') and target[len(ROOT)+1:].split('/')[0] not in exclusions: legacy_only=True
    ensure_dir(CONTROL+'/generations')
    for path in (CONTROL+'/journal',CONTROL+'/journal/.agentx',JOURNAL): ensure_dir(path,WORKER_UID)
    if high_water>0:
        for journal in (JOURNAL,legacy):
            for path in (os.path.dirname(journal),journal,journal+'/fences'): ensure_dir(path,WORKER_UID)
            fence_path=journal+'/fences/'+workspace+'.json'; save(fence_path,high_water)
            fd=open_regular(fence_path)
            try: os.fchown(fd,WORKER_UID,WORKER_UID)
            finally: os.close(fd)
    if legacy_only:
        prepare_run(); return 'legacy'
    size=(shutil.disk_usage(ROOT).free*3//4)//4096*4096
    if size<256*1024*1024:
        prepare_run(); return 'legacy'
    for r in records: save(JOURNAL+'/'+r['operationId']+'.json',r)
    for r in journal_records():
        fd=open_regular(JOURNAL+'/'+r['operationId']+'.json')
        try: os.fchown(fd,WORKER_UID,WORKER_UID)
        finally: os.close(fd)
    data_id=str(uuid.uuid4()); backing=CONTROL+'/generations/'+data_id+'.ext4'
    if records:
        carrier=records[-1]; carrier['layoutMigration']={'schemaVersion':1,'phase':'intent','dataGeneration':data_id}; save(JOURNAL+'/'+carrier['operationId']+'.json',carrier)
    with os.fdopen(open_regular(backing,os.O_WRONLY|os.O_CREAT|os.O_EXCL),'wb') as f: f.truncate(size); f.flush(); os.fsync(f.fileno())
    os.chmod(backing,0o600); run('mkfs.ext4','-F','-q',backing); os.mkdir(DATA)
    device=run('losetup','--find','--show',backing); run('mount','-t','ext4','-o','rw,noatime',device,DATA); os.chown(DATA,1000,1000)
    for entry in os.scandir(ROOT):
        if entry.name not in exclusions: run('cp','-a','--',entry.path,DATA+'/')
    run('sync','-f',DATA)
    value={'schemaVersion':1,'workspaceId':workspace,'generation':{'sessionGeneration':int(generation),'instanceId':instance,'volumeId':volume,'dataGeneration':data_id},'filesystemId':run('blkid','-s','UUID','-o','value',device)}
    save(CURRENT,value); os.chown(ROOT,0,0); os.chmod(ROOT,0o755); publish_view(value)
    if records:
        carrier['layoutMigration']['phase']='committed'; save(JOURNAL+'/'+carrier['operationId']+'.json',carrier); os.chown(JOURNAL+'/'+carrier['operationId']+'.json',1000,1000)
    return 'migrated'
def successor(operation_id):
    r=record(operation_id); value=current()
    if value.get('successorOperationId')==operation_id: return value['generation']
    selector=r['supersedesRetention']; original=record(selector['inspectionOperationId']); state=original['closeRetention']
    if r['fence']<=original['fence'] or state['phase']!='sealed' or state.get('supersededBy') or state['terminalReply']['retention']!=selector or selector['generation']!=value['generation']: raise ValueError('successor authority mismatch')
    sealed(value)
    next_value=dict(value,successorOperationId=operation_id,generation=dict(value['generation'],dataGeneration=str(uuid.uuid4())))
    backing=image(next_value); copy_regular(image(value),backing); os.chmod(backing,0o600)
    subprocess.run(('e2fsck','-fp',backing),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=600); run('tune2fs','-U','random',backing)
    with os.fdopen(open_regular(backing),'rb') as f: os.fsync(f.fileno())
    device=run('losetup','--find','--show',backing); next_value['filesystemId']=run('blkid','-s','UUID','-o','value',device)
    data_directory(); run('mount','-t','ext4','-o','rw,noatime',device,DATA)
    publish_view(next_value); save(CURRENT,next_value)
    return next_value['generation']
class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        lock=None; mode=None
        try:
            while True:
                raw=self.rfile.readline(4097)
                if not raw: break
                if len(raw)>4096: raise ValueError('oversize request')
                m=parse_control_json(raw)
                if not isinstance(m,dict) or set(m)-{'action','operationId'}: raise ValueError('unknown fields')
                action=m.get('action')
                if lock is None:
                    if action not in ('lock-read','lock-write') or set(m)!={'action'}: raise ValueError('ownership required')
                    lock=os.fdopen(open_regular(CONTROL+'/ownership.lock'),'rb'); mode=action; fcntl.flock(lock,fcntl.LOCK_SH if mode=='lock-read' else fcntl.LOCK_EX); result=None
                elif action=='verify' and set(m)=={'action','operationId'}:
                    _,value=retained_command(m['operationId']); result=sealed(value)
                elif action=='seal' and mode=='lock-write' and set(m)=={'action','operationId'}: result=seal(m['operationId'])
                elif action=='successor' and mode=='lock-write' and set(m)=={'action','operationId'}: result=successor(m['operationId'])
                else: raise ValueError('unsupported action')
                self.wfile.write((json.dumps({'ok':True,'result':result})+'\n').encode()); self.wfile.flush()
        except Exception:
            self.wfile.write(b'{"ok":false}\n'); self.wfile.flush()
        finally:
            if lock is not None: lock.close()
if sys.argv[1]=='restore':
    reject_control_mount_aliases()
    with os.fdopen(open_regular(CONTROL+'/ownership.lock'),'rb') as lock: fcntl.flock(lock,fcntl.LOCK_EX); validate_boot(*sys.argv[2:]); restore()
elif sys.argv[1]=='init':
    reject_control_mount_aliases()
    if not os.path.lexists(CONTROL):
        os.mkdir(CONTROL,0o755); os.chmod(CONTROL,0o755)
    protected(CONTROL,True)
    require(stat.S_IMODE(os.lstat(CONTROL).st_mode)==0o755)
    if not os.path.lexists(CONTROL+'/ownership.lock'):
        os.close(open_regular(CONTROL+'/ownership.lock',os.O_WRONLY|os.O_CREAT|os.O_EXCL))
        syncdir(CONTROL)
    with os.fdopen(open_regular(CONTROL+'/ownership.lock'),'rb') as lock: fcntl.flock(lock,fcntl.LOCK_EX); print(migrate(*sys.argv[2:]))
elif sys.argv[1]=='serve':
    reject_control_mount_aliases()
    if os.path.lexists(CURRENT): validate_boot(*sys.argv[2:])
    protected(CONTROL+'/ownership.lock'); prepare_run()
    path=RUN+'/control.sock'
    if os.path.exists(path): os.unlink(path)
    with socketserver.ThreadingUnixStreamServer(path,Handler) as server:
        os.chmod(path,0o660); os.chown(path,0,1000); server.serve_forever()
else: raise ValueError('unsupported entry point')
PY
