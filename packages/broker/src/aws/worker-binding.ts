// The foundation's worker binding: the launch template and one subnet per zone, in the order of the PrivateSubnetIds
// the stack was given (as the foundation's Ec2WorkerSubnets lists them). Used where a deployment registers work of its
// own, with no administrator to name a binding: runtime requalification, and (spec 065b) a project a sign-in client
// creates.
import { DescribeSubnetsCommand, type EC2Client } from "@aws-sdk/client-ec2";
import { Ec2RuntimeBindingSchema, type Ec2RuntimeBinding } from "@agentx/contracts";

export async function foundationWorkerBinding(ec2: Pick<EC2Client, "send">, environment: { privateSubnetIds: string; launchTemplateId: string }): Promise<Ec2RuntimeBinding> {
  const ids = environment.privateSubnetIds.split(",").map((id) => id.trim()).filter((id) => id !== "");
  const described = (await ec2.send(new DescribeSubnetsCommand({ SubnetIds: ids }))).Subnets ?? [];
  const subnets = ids.map((subnetId) => {
    const availabilityZone = described.find((subnet) => subnet.SubnetId === subnetId)?.AvailabilityZone;
    if (availabilityZone === undefined) throw new Error("a worker subnet was not found");
    return { availabilityZone, subnetId };
  });
  return binding(environment.launchTemplateId, subnets);
}

/** The same binding from the foundation's Ec2WorkerSubnets (availabilityZone=subnetId pairs), with no AWS call. */
export function workerBindingFromPairs(pairs: string, launchTemplateId: string): Ec2RuntimeBinding {
  const subnets = pairs.split(",").map((pair) => pair.trim()).filter((pair) => pair !== "").map((pair) => {
    const [availabilityZone = "", subnetId = ""] = pair.split("=");
    return { availabilityZone, subnetId };
  });
  return binding(launchTemplateId, subnets);
}

function binding(launchTemplateId: string, subnets: Array<{ availabilityZone: string; subnetId: string }>): Ec2RuntimeBinding {
  return Ec2RuntimeBindingSchema.parse({ deploymentMode: "ec2-ebs", launchTemplateId, subnets, volumeSizeGiB: 20, volumeType: "gp3" });
}
