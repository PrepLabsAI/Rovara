// The task page's one script and its stylesheet. Both are static text: no model or reader value is ever put in them.


/** Colours are custom properties with a dark set; nothing scrolls the page sideways at 360 px (code blocks and tables scroll inside themselves). */
export const TASK_PAGE_STYLE = String.raw`:root{color-scheme:light dark;--bg:#fff;--fg:#1b1f24;--muted:#57606a;--line:#d0d7de;--panel:#f6f8fa;--focus:#0969da;--ok:#1a7f37;--warn:#9a6700;--bad:#cf222e;font-family:system-ui,sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9da7b3;--line:#30363d;--panel:#161b22;--focus:#58a6ff;--ok:#3fb950;--warn:#d29922;--bad:#ff7b72}}
*{box-sizing:border-box}
body{margin:0 auto;max-width:52rem;padding:clamp(1rem,4vw,2.5rem);line-height:1.55;background:var(--bg);color:var(--fg);overflow-wrap:anywhere}
h1,h2,h3,h4{line-height:1.2}h1{margin:.2rem 0 .5rem}
.muted{color:var(--muted)}
.tag{display:inline-block;border:1px solid currentColor;border-radius:999px;padding:0 .5rem;font-size:.85rem}
a{color:var(--focus)}
a:focus,summary:focus{outline:3px solid var(--focus);outline-offset:2px}
summary{cursor:pointer}
figure,details,table,blockquote,svg{max-width:100%;min-width:0}
pre{display:block;overflow-x:auto;max-width:100%;margin:.5rem 0;padding:.5rem 1rem;background:var(--panel);border-left:3px solid var(--line);font-family:ui-monospace,monospace;font-size:.9rem}
pre,.checks table{scrollbar-width:auto;scrollbar-color:var(--muted) var(--panel)}
pre{background:linear-gradient(to right,var(--panel),var(--panel)) left/1.5rem 100% no-repeat local,linear-gradient(to left,var(--panel),var(--panel)) right/1.5rem 100% no-repeat local,linear-gradient(to right,var(--line),transparent) left/.7rem 100% no-repeat scroll,linear-gradient(to left,var(--line),transparent) right/.7rem 100% no-repeat scroll,var(--panel)}
@supports not (scrollbar-color:auto){pre::-webkit-scrollbar,.checks table::-webkit-scrollbar{height:.6rem;background:var(--panel)}
pre::-webkit-scrollbar-thumb,.checks table::-webkit-scrollbar-thumb{background:var(--muted);border-radius:999px}}
pre.doc-text{white-space:pre-wrap;overflow-wrap:anywhere}
code{font-family:ui-monospace,monospace}
svg{height:auto}
.progress{display:flex;flex-wrap:wrap;gap:.25rem .5rem;list-style:none;margin:.75rem 0;padding:0}
.step{border:1px solid var(--line);border-radius:999px;padding:.1rem .7rem;font-size:.9rem;color:var(--muted)}
.step a{color:inherit;text-decoration:underline;text-underline-offset:.2em}
.step a:hover{color:var(--focus)}
.step a:focus{outline:3px solid var(--focus);outline-offset:2px;border-radius:999px}
.step.done{color:var(--fg)}
.step.done::before{content:"\2713\00a0"}
.step.current{border-color:var(--focus);color:var(--fg);font-weight:600}
.step.current::before{content:"\25cf\00a0"}
main>section,.kind{border-top:1px solid var(--line);padding:.5rem 0}
.kind>details>summary{font-weight:600}
.from-note{background:var(--panel);border-left:3px solid var(--focus);padding:.4rem .8rem}
.doc-header h2,.doc-header h3{margin-bottom:.2rem}
.doc-title{margin:.1rem 0;font-weight:600}
.doc-status{margin:.2rem 0}
.status{border-radius:999px;padding:0 .5rem;font-size:.85rem;border:1px solid currentColor}
.status.approved{color:var(--ok)}
.status.pending{color:var(--warn)}
.not-current{color:var(--muted)}
.versions{margin-top:1rem}
.versions>.doc{border-top:1px dashed var(--line);margin-top:.75rem}
.claim{margin:.3rem 0;border-left:2px solid var(--line);padding-left:.6rem}
.claim-id{font-family:ui-monospace,monospace;color:var(--muted)}
.claim-text{font-weight:500}
.level-1>summary .claim-text{font-size:1.05rem}
.claim-body{margin:.3rem 0 .3rem .5rem}
.more{margin:.3rem 0}
.badge{display:inline-block;border:1px solid currentColor;border-radius:999px;padding:0 .45rem;font-size:.75rem;font-weight:400}
.badge-new{color:var(--ok)}
.badge-changed,.badge-approved-changed{color:var(--warn)}
.badge-recommended{color:var(--focus)}
.evidence{margin:.5rem 0;padding:0}
.evidence figcaption,.evidence-status,.evidence-note,.lang{color:var(--muted);font-size:.85rem}
.evidence-missing{border:1px dashed var(--line);padding:.3rem .6rem}
.evidence-quote,.why-quote{margin:.5rem 0;padding:.2rem 1rem;border-left:3px solid var(--line)}
.evidence-quote footer,.why-quote footer{color:var(--muted);font-size:.85rem}
.ln{display:inline-block;min-width:3ch;margin-right:1ch;text-align:right;color:var(--muted);user-select:none}
.evidence-code pre,.evidence-sketch pre{white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2}
.code-line{display:inline-grid;grid-template-columns:auto minmax(0,1fr);vertical-align:top;width:100%}
.code-text{min-width:0}
.decision{border:1px solid var(--line);border-radius:.4rem;margin:.6rem 0;padding:.4rem .8rem;background:var(--panel)}
.decision-id{font-weight:700}
.options{list-style:none;margin:.3rem 0;padding:0}
.option{margin:.25rem 0}
.option.recommended .option-label{font-weight:600}
.consequence,.decision-note,.decision-claim{color:var(--muted)}
.decision-list{margin:.5rem 0}
.decision-list-title{margin:0 0 .2rem;font-weight:600}
.decision-list ul{margin:0;padding-left:1.2rem}
.decision-link{overflow-wrap:anywhere}
.changes,.why{margin:.5rem 0}
.checks table{display:block;overflow-x:auto;border-collapse:collapse}
.checks th,.checks td{border:1px solid var(--line);padding:.2rem .5rem;text-align:left;word-break:normal;overflow-wrap:normal;white-space:nowrap}
.checks th.check-label,.checks td.check-label{white-space:normal;overflow-wrap:break-word}
.e2e-rows{display:block;overflow-x:auto;border-collapse:collapse}
.e2e-rows th,.e2e-rows td{border:1px solid var(--line);padding:.2rem .5rem;text-align:left;vertical-align:top;overflow-wrap:anywhere}
.e2e-rows tr[data-status="FAILED"] td:nth-child(2){color:var(--bad);font-weight:600}
.e2e-rows tr[data-status="PASSED"] td:nth-child(2){color:var(--ok)}
.e2e-rows tr[data-status="UNKNOWN"] td:nth-child(2){color:var(--warn)}
.flash{outline:3px solid var(--focus);outline-offset:2px;background:var(--panel)}
.history{padding-left:1.2rem}
.history time{color:var(--muted);font-size:.85rem}
.accepted-by{color:var(--muted)}
.task-people-list{list-style:none;margin:0;padding:0;display:grid;gap:.6rem}
.task-people-person,.task-people-confirmation{border:1px solid var(--line);border-radius:.4rem;padding:.6rem;min-width:0}
.task-people-person h3,.task-people-person p{margin:.2rem 0}
.task-people-role{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.4rem .6rem;align-items:end;margin-top:.5rem}
.task-people-role label,.task-people-status{grid-column:1/-1}
.task-people select{min-height:2.75rem;max-width:100%;font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:.4rem}
.task-people-you{font-size:.75rem;border:1px solid currentColor;border-radius:999px;padding:0 .4rem}
.task-people-takeover{margin-top:.75rem}.task-people-confirmation a{display:inline-block;margin-left:.75rem}
[hidden]{display:none!important}
.moved-on{position:sticky;top:0;z-index:1;display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1rem;margin:0 0 .75rem;padding:.5rem .8rem;background:var(--panel);border:1px solid var(--focus);border-radius:.4rem}
.moved-on p{margin:0}
.moved-on button{font:inherit;padding:.2rem .8rem;border:1px solid var(--focus);border-radius:999px;background:var(--bg);color:var(--fg);cursor:pointer}
.moved-on button:focus{outline:3px solid var(--focus);outline-offset:2px}
.decide-bar{position:sticky;bottom:0;display:flex;flex-wrap:wrap;gap:.5rem;padding-bottom:calc(.5rem + env(safe-area-inset-bottom));align-items:center;z-index:1;margin:1rem 0 0;padding-top:.5rem;padding-left:.5rem;padding-right:.5rem;background:var(--panel);border-top:2px solid var(--focus)}
.decide-bar p{margin:0;flex:1 1 10rem}
button,.decide-bar button{min-height:2.75rem}
button{font:inherit;padding:.4rem 1rem;border:1px solid var(--line);border-radius:.4rem;background:var(--bg);color:var(--fg);cursor:pointer}
button:focus,input:focus,textarea:focus{outline:3px solid var(--focus);outline-offset:2px}
textarea{width:100%;max-width:100%;min-height:5rem;font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:.3rem}
dialog{width:min(40rem,100vw);max-height:100dvh;overflow-y:auto;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:.5rem}
dialog::backdrop{background:rgba(0,0,0,.4)}
.dialog-actions{display:flex;flex-wrap:wrap;gap:.5rem}
.answer{border:0;margin:0;padding:0;min-width:0}
.answer legend{padding:0;font-weight:500}
.answer .option{display:flex;gap:.5rem;align-items:flex-start}
.answer input[type=radio]{min-width:1.25rem;min-height:1.25rem;margin-top:.3rem}
.no-decisions{color:var(--muted)}
.suggestions{margin:.2rem 0;color:var(--muted)}
.comments{margin:.5rem 0}
.threads,.replies{list-style:none;margin:0;padding:0}
.replies{margin-left:1rem;border-left:2px solid var(--line);padding-left:.6rem}
.comment{margin:.4rem 0;padding:.3rem .6rem;border:1px solid var(--line);border-radius:.4rem;min-width:0}
.comment-agentx{background:var(--panel)}
.comment-meta{margin:0;font-size:.85rem;color:var(--muted)}
.comment-author{color:var(--fg);font-weight:600}
.comment-text{margin:.2rem 0;white-space:pre-wrap;overflow-wrap:anywhere}
.comment-state,.comment-sent,.comment-deleted,.from-version,.comment-edited{color:var(--muted);font-size:.9rem}
.comment-state,.comment-sent,.comment-deleted,.comment-link{margin:.2rem 0}
.comment-link{font-size:.9rem}
.chip{display:inline-block;border-radius:999px;padding:0 .5rem;font-size:.8rem;font-weight:600;background:var(--focus);color:var(--bg)}
.tag-owner{font-size:.75rem}
.badge-comments{color:var(--muted)}
.removed-claim{border-top:1px dashed var(--line);margin:.5rem 0}
.comment-error,.error{color:var(--warn);font-weight:600}
.comment-form{margin:.4rem 0}.comment-form label{display:block}.comment-form .comment-ask{display:flex;gap:.5rem;align-items:center;min-height:2.75rem}
#decide-dialog label{display:inline}#decide-dialog li{margin:.3rem 0}#decide-dialog input[type=checkbox]{min-width:1.25rem;min-height:1.25rem}
@media (max-width:35rem){dialog{margin:0;width:100vw;max-width:100vw;height:100dvh;max-height:100dvh;border-radius:0}}
@media (max-width:35rem){body{padding:1rem}
.task-people-role{grid-template-columns:1fr}.task-people-role label,.task-people-status{grid-column:1}.task-people-role button{width:100%}
.checks table,.checks tbody,.checks tr{display:block;overflow-x:visible}
.checks thead{position:absolute;height:1px;overflow:hidden;clip-path:inset(50%)}
.checks tr{border:1px solid var(--line);margin:.4rem 0;padding:.3rem .5rem}
.checks td{display:inline;border:0;padding:0}
.checks td.check-label{display:block;font-weight:600}
.checks td.check-proves,.checks td.check-status{white-space:normal}
.checks td.check-proves::before,.checks td.check-status::before{content:"\0020\00b7\0020"}}
`.replace(/\n/g, "");


