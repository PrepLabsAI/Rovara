/** TEMPORARY (T6 ANSWER-1): R4's shape. 9d replaces this type-only import with ../aws/company-check.js when R4 lands. */
export interface CompanyMembershipReader {
  companyOf(personId: string): Promise<string | undefined>;
}
