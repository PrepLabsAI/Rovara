// In-process model of the REQUIRED IAM answer matrix, not proof of IAM expressibility or deployed IAM.
// The infra lane must verify create-time TagResource context in AWS docs and the IAM simulator.
import { CreateSecretCommand, DeleteSecretCommand, DescribeSecretCommand, GetSecretValueCommand, PutSecretValueCommand, TagResourceCommand, UntagResourceCommand } from "@aws-sdk/client-secrets-manager";
import type { CompanySession, CompanySessionRequest } from "../../../packages/aws-adapters/src/secrets-manager/tagged-session.js";
import type { ConnectionSecretsClient, ConnectionSecretsCommand } from "../../../packages/aws-adapters/src/secrets-manager/connection-secrets.js";
type FakeCommand = ConnectionSecretsCommand | DescribeSecretCommand | UntagResourceCommand;
type FakeClient = { send(command: FakeCommand): ReturnType<ConnectionSecretsClient["send"]> };
interface HeldSecret { tags: Record<string,string>; versions: Map<string,string>; deleted: boolean }
const refusal = (name: string): Error => Object.assign(new Error("fake service refusal"), {name});
export class CompanySecretsManagerFake {
  readonly secrets = new Map<string,HeldSecret>();
  readonly sessions: CompanySessionRequest[] = [];
  readonly calls: FakeCommand[] = [];
  readonly deletions: Array<{SecretId:string;RecoveryWindowInDays:number}> = [];
  readonly #sessions = new Map<string,string>();
  #counter = 0;
  constructor(private readonly now: ()=>number = Date.now) {}
  seed(name:string,value:string,tags:Record<string,string>):void { this.secrets.set(name,{tags:{...tags},versions:new Map([["seed",value]]),deleted:false}); }
  assumeRole = async (request: CompanySessionRequest): Promise<CompanySession> => {
    this.sessions.push(structuredClone(request));
    const accessKeyId = `fake-session-${++this.#counter}`;
    this.#sessions.set(accessKeyId,request.tags[0]!.Value);
    return {credentials:{accessKeyId,secretAccessKey:["fake","secret"].join("-"),sessionToken:"fake-session"},expiresAt:this.now()+request.durationSeconds*1000};
  };
  clientFrom = (credentials:CompanySession["credentials"]): FakeClient => {
    const company = this.#sessions.get(credentials.accessKeyId);
    if(company === undefined) throw refusal("AccessDeniedException");
    return this.client(company);
  };
  unrestricted():FakeClient { return this.client(undefined); }
  // The test environment is local; resource ownership is checked BEFORE existence or tags.
  private ownsPath(company: string, name: string): boolean {
    const parts = name.split("/");
    return parts[0] === "agentx" && parts[1] === "local" && parts[2]?.startsWith("org-") === true && parts[3] === company && parts.length >= 5;
  }
  private authorizeOrgTag(company: string | undefined, tags: Record<string, string>, creating: boolean): void {
    // A direct org tag edit is forbidden even when the value is unchanged or the old tag is absent.
    if (!creating) throw refusal("AccessDeniedException");
    if (company !== undefined && tags["rovara:org"] !== company) throw refusal("AccessDeniedException");
  }
  private client(company:string|undefined):FakeClient {
    return {send:async(command)=>{
      this.calls.push(command);
      const name = (command instanceof CreateSecretCommand ? command.input.Name : command.input.SecretId)!;
      if (company !== undefined && !this.ownsPath(company, name)) throw refusal("AccessDeniedException");
      if(command instanceof CreateSecretCommand) {
        const {Name,SecretString,Tags}=command.input;
        const tags=Object.fromEntries((Tags??[]).map(tag=>[tag.Key!,tag.Value!]));
        // CreateSecret with Tags must also pass the creation-context TagResource rule.
        this.authorizeOrgTag(company, tags, true);
        if(this.secrets.has(Name!)) throw refusal("ResourceExistsException");
        const version=`v${++this.#counter}`;
        this.secrets.set(Name!,{tags,versions:new Map([[version,SecretString!]]),deleted:false});
        return {VersionId:version};
      }
      const held = this.secrets.get(name);
      if (held === undefined) throw refusal("ResourceNotFoundException");
      if(command instanceof TagResourceCommand) {
        if(command.input.Tags?.some(tag=>tag.Key === "rovara:org")) this.authorizeOrgTag(company, Object.fromEntries(command.input.Tags.map(tag=>[tag.Key!,tag.Value!])), false);
        for(const tag of command.input.Tags??[]) held.tags[tag.Key!]=tag.Value!;
        return {};
      }
      if (command instanceof UntagResourceCommand) {
        if (command.input.TagKeys?.includes("rovara:org")) throw refusal("AccessDeniedException");
        for (const key of command.input.TagKeys ?? []) delete held.tags[key];
        return {};
      }
      if (command instanceof DescribeSecretCommand) return {};
      if(command instanceof DeleteSecretCommand) {
        held.deleted=true;this.deletions.push({SecretId:command.input.SecretId!,RecoveryWindowInDays:command.input.RecoveryWindowInDays!});return {};
      }
      if(held.deleted) throw refusal("InvalidRequestException");
      if(command instanceof PutSecretValueCommand) {const version=`v${++this.#counter}`;held.versions.set(version,command.input.SecretString!);return {VersionId:version};}
      if(command instanceof GetSecretValueCommand) {
        const value=command.input.VersionId===undefined?[...held.versions.values()].at(-1):held.versions.get(command.input.VersionId);
        if(value===undefined) throw refusal("ResourceNotFoundException");return {SecretString:value};
      }
      throw refusal("InvalidRequestException");
    }};
  }
}
