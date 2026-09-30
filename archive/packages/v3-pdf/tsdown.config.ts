import {defineConfig} from "tsdown";
export default defineConfig({entry:["src/index.ts"],format:"esm",dts:true,
  noExternal:(id,importer)=>/^@crawl-automation\/v3-(contracts|artifacts)$/.test(id)&&!/\.d\.[cm]?ts$/.test(importer??"")});
