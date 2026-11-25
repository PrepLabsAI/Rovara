// The Code API's version, as two plain constants a script can read from a checkout.
//
// CODE_API_VERSION ("major.minor") is the number a client compares with the one Code serves. It was DEVELOPER_API_VERSION (packages/contracts/src/developer.ts, served by the discovery document and
// compared by `apiVersionCompatible`); there is one number, and contracts re-exports it under the old name. A different major refuses; a newer server minor shows an upgrade notice.
//
// CODE_API_MIN_CLIENT ("major.minor") is the oldest version of this package a client may be built against and still be served. Code raises it only after the client side has stopped using what is
// being removed (see README.md, "Skew"). A test pins a digest of the contract surface and fails when the surface changes without a bump here.
export const CODE_API_VERSION = "1.5";
export const CODE_API_MIN_CLIENT = "1.2";
