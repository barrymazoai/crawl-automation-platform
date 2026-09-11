import { test } from "node:test";
import assert from "node:assert/strict";
import { retentionCheck, loadConfig, parseConfig } from "./live-config.mjs";
import { createInspectionClient, mayContinueWithoutRetention } from "./live-inspection.mjs";
import { GetBucketLifecycleConfigurationCommand } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";

test("real SDK inspection cannot annotate the strict factory's credential input", async () => {
  const credentials={accessKeyId:"fake-id",secretAccessKey:"fake-secret"},original={...credentials};
  const client=createInspectionClient({endpoint:"https://example.invalid"},credentials,{handle:async()=>({response:{statusCode:403,headers:{"content-type":"application/xml"},body:Readable.from(['<Error><Code>AccessDenied</Code><Message>Denied</Message></Error>'])}})});
  try {await assert.rejects(client.send(new GetBucketLifecycleConfigurationCommand({Bucket:"test"})),{name:"AccessDenied"});}
  finally {client.destroy();}
  assert.deepEqual(credentials,original);
});
test("only explicitly selected object diagnostic tolerates lifecycle AccessDenied", () => {
  const denied={name:"AccessDenied",$metadata:{httpStatusCode:403}};
  assert.equal(mayContinueWithoutRetention("--objects-only",denied),true);
  for (const mode of ["--preflight","--run",undefined]) assert.equal(mayContinueWithoutRetention(mode,denied),false);
  for (const error of [{name:"AccessDenied",$metadata:{httpStatusCode:401}},{name:"SignatureDoesNotMatch",$metadata:{httpStatusCode:403}},{name:"TimeoutError"},null]) assert.equal(mayContinueWithoutRetention("--objects-only",error),false);
});

test("accepts either complete config family without mixing credentials", () => {
  for(const prefix of ["S3_","CLOUDFLARE_R2_"]) {
    const env=Object.fromEntries(Object.entries({ENDPOINT:"https://example.invalid",BUCKET:"test",ACCESS_KEY_ID:"fake-id",SECRET_ACCESS_KEY:"fake-secret",REGION:"auto"}).map(([key,value])=>[prefix+key,value]));
    assert.deepEqual(parseConfig(env),{endpoint:"https://example.invalid",bucket:"test",credentials:{accessKeyId:"fake-id",secretAccessKey:"fake-secret"}});
  }
});
test("rejects mixed families incomplete credentials and non-auto region", () => {
  assert.throws(()=>parseConfig({S3_ENDPOINT:"x",CLOUDFLARE_R2_BUCKET:"y"}), /CONFIG_AMBIGUOUS_FAMILIES/);
  assert.throws(()=>parseConfig({CLOUDFLARE_R2_BUCKET:"y"}), /CONFIG_S3_FIELDS_REQUIRED/);
  assert.throws(()=>parseConfig({S3_ENDPOINT:"x",S3_BUCKET:"y",S3_ACCESS_KEY_ID:"fake",S3_SECRET_ACCESS_KEY:"fake",S3_REGION:"other"}), /CONFIG_REGION_MUST_BE_AUTO/);
});

test("requires explicit absolute config path", async () => {
  await assert.rejects(loadConfig(".env"), /CONFIG_ABSOLUTE_PATH_REQUIRED/);
});
test("no rules and multipart-only rules allow completed evidence retention", () => {
  assert.equal(retentionCheck([], "crawlv3-acceptance/run").safeForAcceptance, true);
  assert.equal(retentionCheck([{Status:"Enabled", AbortIncompleteMultipartUpload:{DaysAfterInitiation:7}}], "crawlv3-acceptance/run").safeForAcceptance, true);
});
test("global and ancestor expiry rules block writes", () => {
  for (const Prefix of ["", "crawlv3-acceptance/", "crawlv3-acceptance/run/"]) {
    assert.equal(retentionCheck([{Status:"Enabled",Filter:{Prefix},Expiration:{Days:1}}], "crawlv3-acceptance/run").safeForAcceptance, false);
  }
});
test("descendant and tagged expiry rules are conservatively blocked", () => {
  for (const Filter of [{Prefix:"crawlv3-acceptance/run/sources/"}, {Tag:{Key:"x",Value:"y"}}]) {
    assert.equal(retentionCheck([{Status:"Enabled",Filter,Expiration:{Days:1}}], "crawlv3-acceptance/run").safeForAcceptance, false);
  }
});
test("disabled and unrelated prefix expiry rules do not block", () => {
  assert.equal(retentionCheck([{Status:"Disabled",Expiration:{Days:1}}, {Status:"Enabled",Filter:{Prefix:"unrelated/"},Expiration:{Days:1}}], "crawlv3-acceptance/run").safeForAcceptance, true);
});
