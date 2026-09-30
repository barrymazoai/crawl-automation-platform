import { expect, it } from "vitest";
import { CatalogDatabaseConfig, CatalogProductConfig, CatalogSourceConfig } from "./catalog-config.js";
const database = { connectionString:"postgresql://test@localhost/crawler_v3_test",tls:false };
it("Presence configuration needs no browser, R2, files or model settings",()=>{expect(CatalogDatabaseConfig.parse({database})).toEqual({database});});
it("product input resolver needs only database and explicit product configuration",()=>{expect(CatalogProductConfig.parse({database,clusterId:"test",products:[]})).toMatchObject({products:[]});});
it("source/ledger roles cannot start without durable evidence configuration",()=>{expect(CatalogSourceConfig.safeParse({database}).success).toBe(false);});
it("cross-role credentials are not silently accepted by presence",()=>{expect(CatalogDatabaseConfig.safeParse({database,r2Credentials:{accessKeyId:"test",secretAccessKey:"test"}}).success).toBe(false);});
