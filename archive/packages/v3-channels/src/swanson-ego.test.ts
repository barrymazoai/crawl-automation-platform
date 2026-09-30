import {expect,it} from "vitest";
import {runInNewContext} from "node:vm";
import {swansonCanonicalExpression} from "./swanson-ego.js";
it("uses explicit product OpenGraph identity only when canonical is absent; never substitutes location",()=>{
 const url="https://www.swansonvitamins.com/p/linked-size",read=(link:any,type:any,og:any)=>runInNewContext(swansonCanonicalExpression,{location:{href:"https://evil.example/"},document:{querySelector:(s:string)=>s==='link[rel="canonical"]'?link:s==='meta[property="og:type"]'?type:og}});
 expect(read(null,{content:"product"},{content:url})).toBe(url);
 expect(read({href:url},{content:"website"},{content:"other"})).toBe(url);
 expect(read(null,{content:"website"},{content:url})).toBeUndefined();
 expect(read(null,{content:"product"},null)).toBeUndefined();
});
