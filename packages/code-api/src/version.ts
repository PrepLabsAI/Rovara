// The Code API's version, as two plain constants a script can read from a checkout.
//
// CODE_API_VERSION ("major.minor") is the number a client compares with the one Code serves. It was DEVELOPER_API_VERSION (packages/contracts/src/developer.ts, served by the discovery document and
// compared by `apiVersionCompatible`); there is one number, and contracts re-exports it under the old name. A different major refuses; a newer server minor shows an upgrade notice.
//
// CODE_API_MIN_CLIENT ("major.minor") is the oldest version of this package a client may be built against and still be served. Code raises it only after the client side has stopped using what is
// being removed (see README.md, "Skew"). A test pins a digest of the contract surface and fails when the surface changes without a bump here.
//
// 1.6 is a CAPABILITY bump with an unchanged digest (PROJECT-INCARNATION-FENCE): the archive and restore confirm bodies take the optional `expectedProjectIncarnation`, and those two rows carry no schema in
// ROUTES, so the digest cannot see it. Cloud reads this number from the discovery document and sends that member only to a Code at 1.6 or later (packages/cloud-server, CODE_API_TAKES_INCARNATION).
// MERGE CHECKLIST: CODE_API_VERSION must stay >= 1.6 (a merge that takes another lane's lower or equal number silently turns the fence OFF: Cloud stops sending the member, with no error), and Cloud's
// CODE_API_TAKES_INCARNATION must stay equal to the number that carries the field. If the number moves, move both, and the pretend Code in Cloud's tests/unit/project-lifecycle-routes.test.ts.
export const CODE_API_VERSION = "1.6";
export const CODE_API_MIN_CLIENT = "1.2";
