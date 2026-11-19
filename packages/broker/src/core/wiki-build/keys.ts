// Wiki W3: the build run's own rows. All of them sit in ONE partition per company AND project (`ORG#<company>#WIKI_BUILD#<project>`), so the company purge removes them by key and no
// read of one project can reach another's (review fixes 4, 5, 7). Rows only, never files.
//   RUN                     the project's pointer to its current (or last) build run: who asked, when, the limits and the commits it started with, the page plan, the progress
//   NOTES#<task>            the "Tell Rovara what matters" notes a run was started with (a person's words: expire with the run's rows; person erase removes them, `eraseWikiBuildNotes`)
//   DONE#<task>#<page>      one row per page a run finished (written or found empty), with what it spent
//   CHECK#<hash>            a cached citation verdict, by file version (the hash covers repository, path, version, line and quote; no file text and no quote is stored)
import { INDEX_EXPIRY_ATTRIBUTE, companyScoped, type DocumentKey, type OrgId } from "@agentx/contracts";

/** Rows of a run (notes, done pages, cached verdicts) are kept this long, like the setup rows. */
export const WIKI_BUILD_KEEP_SECONDS = 31 * 86_400;

export interface WikiBuildScope { orgId: OrgId; project: string }
export interface WikiRunScope extends WikiBuildScope { taskId: string }

export const wikiBuildPartition = (scope: WikiBuildScope): string => companyScoped(scope.orgId, `WIKI_BUILD#${scope.project}`);
export const wikiBuildRunKey = (scope: WikiBuildScope): DocumentKey => ({ pk: wikiBuildPartition(scope), sk: "RUN" });
export const wikiBuildNotesKey = (scope: WikiRunScope): DocumentKey => ({ pk: wikiBuildPartition(scope), sk: `NOTES#${scope.taskId}` });
export const WIKI_DONE_SK_PREFIX = "DONE#";
export const wikiPageDoneKey = (scope: WikiRunScope, pageId: string): DocumentKey => ({ pk: wikiBuildPartition(scope), sk: `${WIKI_DONE_SK_PREFIX}${scope.taskId}#${pageId}` });
export const wikiCheckCacheKey = (scope: WikiBuildScope, hash: string): DocumentKey => ({ pk: wikiBuildPartition(scope), sk: `CHECK#${hash}` });

/** A row of the build's partition by its sort key (for a delete of what a query of the partition gave back): the sort key must be one of this slice's families (RUN, NOTES#, DONE#, CHECK#). */
const BUILD_SK = /^(?:RUN|NOTES#[A-Za-z0-9-]{1,64}|DONE#[A-Za-z0-9-]{1,64}#[a-z0-9-]{1,120}|CHECK#[A-Za-z0-9]{8,128})$/u;
export function wikiBuildRowKey(scope: WikiBuildScope, sk: string): DocumentKey {
  if (!BUILD_SK.test(sk)) throw new Error("not a wiki build row's sort key");
  return { pk: wikiBuildPartition(scope), sk: `${sk}` };
}

export const wikiExpiryOf = (nowMs: number): { [INDEX_EXPIRY_ATTRIBUTE]: number } => ({ [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + WIKI_BUILD_KEEP_SECONDS });
