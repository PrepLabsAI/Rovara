// Shared source for the real sandbox child and the offline inert-socket tests.
// Failure codes go to stdout because runSdkChild intentionally ignores stderr.
export const SDK_EXTERNAL_TCP_PROBE = `
await new Promise((resolve, reject) => {
    const socket = net.connect(9, '192.0.2.1');
    const deadline = setTimeout(() => finish('escaped-or-hung'), 2000);
    function finish(failure) {
        clearTimeout(deadline);
        socket.destroy();
        if (failure) {
            console.log(failure);
            reject(new Error(failure));
        } else {
            resolve();
        }
    }
    socket.once('connect', () => finish('escaped-or-hung'));
    socket.once('error', error => finish(['EPERM', 'EACCES'].includes(error.code) ? undefined : 'wrong-refusal'));
});`;
