# Bring your own Amazon Bedrock

`rovara-bedrock-role.json` is the CloudFormation template that creates the invoke-only IAM role Rovara assumes to call Amazon Bedrock in your own AWS account, on the models you chose. Rovara's hosted service pins its SHA-256 and checks the downloaded file against it before anything is deployed, so do not edit it.
