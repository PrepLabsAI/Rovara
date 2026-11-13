"""Automatically loaded by the isolated venv, before SDK imports. No user data in logs."""
import os
import sys
import json
import socket
import ssl

_log = os.environ.get('SDK_TRIPWIRE_LOG')
_private = os.environ.get('SDK_PRIVATE_ROOT')
if not _log or not _private:
    raise SystemExit('tripwire configuration required')
# Opening now makes startup fail if evidence cannot be written.
with open(_log, 'a', encoding='utf-8'):
    pass


def _check(host):
    if host in ('127.0.0.1', '::1', 'localhost'):
        return
    safe = host if isinstance(host, str) and len(host) <= 253 and all(c.isalnum() or c in '.:-[]' for c in host) else 'unreadable'
    with open(_log, 'a', encoding='utf-8') as evidence:
        evidence.write(json.dumps(safe) + '\n')
    raise PermissionError('SDK_EGRESS_REFUSED')


def _wrap(obj, name, host):
    original = getattr(obj, name, None)
    if original is None:
        return
    def guarded(*args, **kwargs):
        _check(host(args, kwargs))
        return original(*args, **kwargs)
    setattr(obj, name, guarded)


_wrap(socket.socket, 'connect', lambda a,k: a[1][0] if isinstance(a[1],tuple) else 'unreadable')
_wrap(socket.socket, 'connect_ex', lambda a,k: a[1][0] if isinstance(a[1],tuple) else 'unreadable')
_wrap(socket, 'create_connection', lambda a,k: (a[0] if a else k['address'])[0])
_wrap(socket, 'getaddrinfo', lambda a,k: a[0] if a else k['host'])
for _name in ('gethostbyname','gethostbyname_ex','gethostbyaddr'):
    _wrap(socket, _name, lambda a,k: a[0])
_wrap(socket.socket, 'sendto', lambda a,k: a[-1][0] if isinstance(a[-1],tuple) else 'unreadable')
_wrap(ssl.SSLContext, 'wrap_socket', lambda a,k: k.get('server_hostname') or (a[5] if len(a)>5 else 'localhost'))
_runtime = os.path.realpath(sys.base_prefix)
_private = os.path.realpath(_private)
# Exact paths used by pinned truststore/_macos.py; resolve framework symlinks.
# Defence in depth only: framework handles can expose dependency symbols.
# The mandatory sandbox-exec profile is the enforcing network layer.
_system_frameworks = frozenset(os.path.realpath(path) for path in (
    '/System/Library/Frameworks/Security.framework/Security',
    '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation',
))


def _audit(event, args):
    if event in ('open','os.listdir','os.scandir') and args and isinstance(args[0], (str,bytes)):
        path = os.path.realpath(os.fsdecode(args[0]))
        if (path == _private or path.startswith(_private + os.sep)) and not (path == _runtime or path.startswith(_runtime + os.sep)):
            raise PermissionError('SDK_PRIVATE_HOME_REFUSED')
    if event in ('subprocess.Popen','os.system','os.exec','os.posix_spawn'):
        raise PermissionError('SDK_SUBPROCESS_REFUSED')
    if event in ('socket.connect', 'socket.sendto', 'socket.sendmsg'):
        address = args[1]
        _check(address[0] if isinstance(address,tuple) else 'unreadable')
    if event == 'socket.getaddrinfo':
        _check(args[0])
    if event == 'socket.getnameinfo':
        _check(args[0][0])
    if event == 'ctypes.dlopen':
        # No process-wide handle, relative name, libc or other system library.
        name = args[0]
        if not isinstance(name, str) or not os.path.isabs(name):
            raise PermissionError('SDK_NATIVE_LIBRARY_REFUSED')
        path = os.path.realpath(name)
        root = os.path.realpath(sys.prefix) + os.sep
        if path not in _system_frameworks and not path.startswith(root):
            raise PermissionError('SDK_NATIVE_LIBRARY_REFUSED')


sys.addaudithook(_audit)
with socket.socket() as _canary:
    try:
        _canary.connect(('model-canary.rovara-canary.dev', 443))
    except PermissionError as _error:
        if str(_error) != 'SDK_EGRESS_REFUSED':
            raise
    else:
        raise SystemExit('tripwire canary not refused')
sys._sdk_tripwire_active = True
