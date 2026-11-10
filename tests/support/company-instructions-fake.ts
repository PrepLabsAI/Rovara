// A test fake for the company-instructions socket (port lane P6; the shape of Cloud's fake): answers the given snapshots in turn (the last one repeats; an Error among them fails that call), or fails every call when given an Error. Records the company key of each call.
import type { CompanyInstructionsSnapshot, CompanyInstructionsSource } from "../../packages/contracts/src/index.js";

export interface FakeCompanyInstructionsSource extends CompanyInstructionsSource {
  /** The company key each call asked for, in order. */
  readonly asked: string[];
}

export function fakeCompanyInstructionsSource(answers: ReadonlyArray<CompanyInstructionsSnapshot | undefined | Error> | Error): FakeCompanyInstructionsSource {
  const asked: string[] = [];
  let next = 0;
  return {
    asked,
    current(company: string): Promise<CompanyInstructionsSnapshot | undefined> {
      asked.push(company);
      if (answers instanceof Error) return Promise.reject(answers);
      const answer = answers[Math.min(next, answers.length - 1)];
      next += 1;
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer === undefined ? undefined : structuredClone(answer));
    },
  };
}
