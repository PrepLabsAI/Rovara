// The project wiki's keys (lead 4, W2): one partition per company AND project, `ORG#<company>#WIKI#<project>`. The company purge deletes every `ORG#<company>#...` partition, so it
// removes the wiki with no purge change. Every builder checks its parts, so no `#` (or anything outside the id patterns) can move a key boundary.
import { z } from "zod";
import { OrgIdSchema, type OrgId } from "./browser-ids.js";
import { orgScoped } from "./company-scope.js";
import { AGENTX_NAME_PATTERN } from "./names.js";

const ProjectPart = z.string().regex(AGENTX_NAME_PATTERN);
const PagePart = z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/u);
const IdPart = z.string().regex(/^[A-Za-z0-9_-]{4,64}$/u);

export interface WikiKey { pk: string; sk: string }

/** The one partition of a project's wiki in a company: `ORG#<company>#WIKI#<project>`. The company purge removes it by its `ORG#<company>#` prefix. */
export function wikiPartition(orgId: OrgId, project: string): string {
  return orgScoped(OrgIdSchema.parse(orgId), `WIKI#${ProjectPart.parse(project)}`);
}
/** Sort-key families inside a project's wiki partition. */
export const WIKI_SK = { page: "PAGE#", body: "BODY#", note: "NOTE#", flag: "FLAG#", build: "BUILD#", answer: "ANSWER#" } as const;
const pageId = (value: string): string => PagePart.parse(value);
const id = (value: string): string => IdPart.parse(value);
/** A page's index row (small: title, summary, repos, counts) and its body row (blocks and claims), written together. */
export const wikiPageKey = (orgId: OrgId, project: string, page: string): WikiKey => ({ pk: wikiPartition(orgId, project), sk: `${WIKI_SK.page}${pageId(page)}` });
export const wikiBodyKey = (orgId: OrgId, project: string, page: string): WikiKey => ({ pk: wikiPartition(orgId, project), sk: `${WIKI_SK.body}${pageId(page)}` });
export const wikiNoteKey = (orgId: OrgId, project: string, page: string, noteId: string): WikiKey => ({ pk: wikiPartition(orgId, project), sk: `${WIKI_SK.note}${pageId(page)}#${id(noteId)}` });
export const wikiFlagKey = (orgId: OrgId, project: string, page: string, flagId: string): WikiKey => ({ pk: wikiPartition(orgId, project), sk: `${WIKI_SK.flag}${pageId(page)}#${id(flagId)}` });
export const wikiBuildKey = (orgId: OrgId, project: string, buildId: string): WikiKey => ({ pk: wikiPartition(orgId, project), sk: `${WIKI_SK.build}${id(buildId)}` });
export const wikiAnswerKey = (orgId: OrgId, project: string, answerId: string): WikiKey => ({ pk: wikiPartition(orgId, project), sk: `${WIKI_SK.answer}${id(answerId)}` });

/** A stored row's own key, read back from a query of the project's partition: the sort key must be one of the wiki's families (anything else is refused). */
const STORED_SK = /^(?:PAGE|BODY|BUILD|ANSWER)#[A-Za-z0-9_-]{1,120}$|^(?:NOTE|FLAG)#[a-z0-9][a-z0-9-]{0,119}#[A-Za-z0-9_-]{4,64}$/u;
export function wikiRowKey(orgId: OrgId, project: string, sk: string): WikiKey {
  if (!STORED_SK.test(sk)) throw new Error("not a wiki row's sort key");
  return { pk: wikiPartition(orgId, project), sk: `${sk}` };
}
