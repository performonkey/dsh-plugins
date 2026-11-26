function L(e){return new Worker(""+new URL("worker-c05XtfQl.js",import.meta.url).href,{name:e?.name})}function $(e){throw new Error(`web boot: unknown index injection row ${JSON.stringify(e)}`)}async function A(e,t){for(const r of e)switch(r.kind){case"global":globalThis[r.name]=r.value;break;case"script":{const o=document.createElement("script");o.textContent=r.text,(r.placement==="head"?document.head:document.body).append(o);break}case"script-src":await t(r.src);break;case"script-preload":break;case"style":{const o=document.createElement("style");o.textContent=r.text,document.head.append(o);break}case"html":(r.placement==="head"?document.head:document.body).insertAdjacentHTML("beforeend",r.html);break;default:$(r)}}const T="vfs-image.tar.gz",E=new URL("https://preview.invalid/");function U(e){if(e===void 0)return[];if(!Array.isArray(e))throw new Error("preview fixture manifest links must be an array");return e.map(t=>{const r=x(t),o=r?.label,n=r?.href;if(typeof o!="string"||o.length===0||typeof n!="string"||n.length===0||new URL(n,E).origin!==E.origin)throw new Error("preview fixture manifest contains an invalid link");return{label:o,href:n}})}function x(e){return typeof e=="object"&&e!==null&&!Array.isArray(e)?e:void 0}function _(e){const t=x(e);if(t?.version!==1||!Array.isArray(t.fixtures))throw new Error(`preview fixture manifest must use version ${String(1)}`);const r=[],o=new Set;for(const i of t.fixtures){const s=x(i),a=s?.id,c=s?.label,d=s?.description,p=s?.overlays,u=Array.isArray(p)?p.filter(l=>typeof l=="string"&&l.length>0):[];if(typeof a!="string"||!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(a)||a==="none"||a==="webfs"||typeof c!="string"||c.length===0||typeof d!="string"||d.length===0||!Array.isArray(p)||p.length===0||u.length!==p.length)throw new Error("preview fixture manifest contains an invalid fixture entry");if(o.has(a))throw new Error(`preview fixture manifest repeats id "${a}"`);o.add(a),r.push({id:a,label:c,description:d,overlays:u})}const n=t.defaultFixture;if(n!==null&&(typeof n!="string"||!o.has(n)))throw new Error("preview fixture manifest defaultFixture does not name a fixture");return{version:1,defaultFixture:n,fixtures:r,links:U(t.links)}}new TextEncoder;const M=new TextDecoder,w=512;function f(e,t,r){let o=t;for(;o<t+r&&e[o]!==0;)o+=1;return M.decode(e.subarray(t,o))}function O(e){const t=[];let r=0;for(;r+w<=e.length;){const o=e.subarray(r,r+w);if(o.every(l=>l===0))break;const n=f(o,0,100),i=f(o,345,155),s=i===""?n:`${i}/${n}`,a=Number.parseInt(f(o,124,12).trim()||"0",8),c=Number.parseInt(f(o,100,8).trim()||"0",8)&511,d=o[156],p=d===53||s.endsWith("/");if(d!==48&&d!==0&&d!==53)throw new Error(`vfs tar: unsupported entry type ${String.fromCharCode(d??0)} for "${s}"`);const u=r+w;t.push({name:s,bytes:e.subarray(u,u+a),directory:p,mode:c}),r=u+Math.ceil(a/w)*w}return t}const j=new Map([[".svg","image/svg+xml"],[".png","image/png"],[".webp","image/webp"],[".jpg","image/jpeg"],[".jpeg","image/jpeg"]]);function F(e){const t=new Map;for(const r of O(e)){const[,o,n]=/^plugins\/((?:@[^/]+\/)?[^/]+)\/assets\/(.+)$/u.exec(r.name)??[];if(o===void 0||n===void 0)continue;const i=`plugins/${o}/assets/${n.split("/").map(a=>encodeURIComponent(a).replace(/[!'()*]/gu,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/")}`,s=n.slice(n.lastIndexOf(".")).toLowerCase();t.set(i,URL.createObjectURL(new Blob([new Uint8Array(r.bytes)],{type:j.get(s)??""})))}return r=>t.get(r)??r}const P=`
  [data-preview-text-viewer] {
    width: min(960px, calc(100vw - 32px));
    height: min(720px, calc(100dvh - 32px));
    padding: 0;
    box-sizing: border-box;
    border: 1px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%));
    border-radius: var(--dsw-radius-lg, 16px);
    color: var(--dsw-alias-label-primary, #0f1115);
    background: var(--dsw-alias-bg-base, #fff);
    font-family: var(--dsw-font-family, inherit);
  }
  [data-preview-text-viewer][open] { display: flex; flex-direction: column; }
  [data-preview-text-viewer]::backdrop { background: rgb(0 0 0 / 32%); }
  [data-preview-text-viewer] header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--dsw-alias-border-l1, rgb(0 0 0 / 6%));
  }
  [data-preview-text-viewer] h2 {
    flex: 1;
    min-width: 0;
    margin: 0;
    overflow: hidden;
    font-size: 14px;
    line-height: 22px;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  [data-preview-text-viewer] button {
    height: 28px;
    padding: 0 12px;
    border: 1px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%));
    border-radius: var(--dsw-radius-sm, 8px);
    color: inherit;
    background: transparent;
    font: inherit;
    cursor: pointer;
  }
  [data-preview-text-viewer] pre {
    flex: 1;
    margin: 0;
    padding: 16px;
    overflow: auto;
    background: var(--dsw-alias-markdown-code-block, transparent);
    font: 13px/20px ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: pre;
  }
`;function I(e,t){let r=document.querySelector("dialog[data-preview-text-viewer]");if(r===null){const n=document.createElement("style");n.textContent=P,document.head.append(n),r=document.createElement("dialog"),r.dataset.previewTextViewer="";const i=document.createElement("header"),s=document.createElement("h2"),a=document.createElement("button");a.type="button",a.textContent="Close";const c=r;a.addEventListener("click",()=>{c.close()}),r.addEventListener("keydown",d=>{d.stopPropagation()}),i.append(s,a),r.append(i,document.createElement("pre")),document.body.append(r)}const o=r.querySelector("h2");o.textContent=e,o.title=e,r.querySelector("pre").textContent=t,r.open||r.showModal()}var g=class extends Error{dshRemoteStreamFailure;constructor(e,t){super(e.message,t),this.name="TunnelLogicalStreamError",this.dshRemoteStreamFailure=e.kind==="remote"?{kind:"remote",code:e.code,details:e.details}:{kind:"carrier"}}},C=class{frames=[];wake;failed=!1;failure;push(e){this.failed||(this.frames.push(e),this.wake?.(),this.wake=void 0)}fail(e){this.failed||(this.failed=!0,this.failure=e,this.frames.length=0,this.wake?.(),this.wake=void 0)}async next(){for(;this.frames.length===0;){if(this.failed)throw this.failure;await new Promise(e=>{this.wake=e})}return this.frames.shift()}};const B=500,z=new TextEncoder,b=/\/\/# sourceMappingURL=([^\r\n]+)\s*$/;function W(e){const t=new FileReader;return new Promise((r,o)=>{t.addEventListener("load",()=>{r(t.result)},{once:!0}),t.addEventListener("error",()=>{o(t.error??new Error("source map encoding failed"))},{once:!0}),t.readAsDataURL(new Blob([e],{type:"application/json;charset=utf-8"}))})}async function q(e,t,r){const o=b.exec(e);if(o?.[1]===void 0)return e;try{const n=await r(new URL(o[1],new URL(t,globalThis.location.origin)));if(!n.ok)return e.replace(b,"");const i=await W(await n.arrayBuffer());return e.replace(b,`//# sourceMappingURL=${i}`)}catch{return e.replace(b,"")}}function D(e){if(e!=null){if(typeof e=="string")return z.encode(e).buffer;if(e instanceof Blob||e instanceof ReadableStream||e instanceof ArrayBuffer)return e;if(ArrayBuffer.isView(e))return e.buffer.slice(e.byteOffset,e.byteOffset+e.byteLength);throw new Error(`web-preview tunnel: unsupported request body ${Object.prototype.toString.call(e)}`)}}const H=new Set([101,204,205,304]);var N=class{worker;nextId=1;unary=new Map;bodyStreams=new Map;logicalStreams=new Map;inFlight=new Map;releases=new Map;constructor(e){this.worker=e,e.addEventListener("message",t=>{this.receive(t.data)}),e.addEventListener("error",t=>{const r=new Error(`web-preview tunnel: worker failed: ${t.message}`);for(const n of this.inFlight.keys())this.warnRefusal(n,`worker failed: ${t.message}`);this.inFlight.clear();for(const n of this.unary.values())n.reject(r);this.unary.clear();for(const n of this.bodyStreams.values())n.error(r);this.bodyStreams.clear();const o=new g({kind:"carrier",message:`web-preview tunnel: worker failed: ${t.message}`},{cause:r});for(const{inbox:n}of this.logicalStreams.values())n.fail(o);this.logicalStreams.clear();for(const n of this.releases.values())n();this.releases.clear()})}init(e,t=[]){this.worker.postMessage({t:"init",image:e,overlays:t})}fetch=async(e,t)=>{const r=t?.signal;if(r?.aborted===!0)throw new DOMException("The operation was aborted.","AbortError");const o=this.nextId++,n=t?.body===void 0||t.body===null?void 0:D(t.body),i={t:"req",id:o,method:t?.method??"GET",url:new URL(e,globalThis.location.origin).toString(),headers:Object.fromEntries(new Headers(t?.headers).entries()),...n===void 0?{}:{body:n}},s=new Promise((c,d)=>{this.unary.set(o,{resolve:c,reject:d})});if(this.inFlight.set(o,`${i.method} ${i.url}`),n instanceof ReadableStream?this.worker.postMessage(i,[n]):this.worker.postMessage(i),r==null)return await s;const a=this.rejectOnAbort(o,r);try{const c=await Promise.race([s,a.rejected]);return this.bodyStreams.has(o)&&this.observeStreamAbort(o,r),c}finally{a.release()}};async*open(e,t,r,o){r.throwIfAborted();const n=this.nextId++,i=new C,s={inbox:i,pump:void 0};let a=!1,c=!1;const d=()=>{i.fail(r.reason)};r.addEventListener("abort",d,{once:!0}),this.logicalStreams.set(n,s),this.inFlight.set(n,`STREAM ${e}`);try{const p={t:"stream-open",id:n,endpoint:e,payload:t};try{this.worker.postMessage(p),a=!0}catch(u){throw new g({kind:"carrier",message:`web-preview tunnel: failed to open Remote stream ${e}`},{cause:u})}for(o!==void 0&&(s.pump=this.pumpUplink(n,o,r,i));;){const u=await i.next();if(r.throwIfAborted(),u.t==="stream-item"){yield u.value;continue}if(c=!0,u.t==="stream-error")throw new g(u.failure);return}}finally{r.removeEventListener("abort",d),this.logicalStreams.delete(n),this.inFlight.delete(n),s.pump?.stop(),a&&!c&&this.abortWorkerOperation(n),s.pump!==void 0&&await s.pump.done}}pumpUplink(e,t,r,o){const n=Promise.withResolvers(),i=t[Symbol.asyncIterator](),s={active:!0,released:!1},a=()=>{s.released||(s.released=!0,Promise.resolve(i.return?.()).catch(()=>{}))};return{done:this.forwardUplink(e,i,n.promise,()=>s.active&&!r.aborted).then(c=>{s.released||=c},c=>{o.fail(c)}).then(a),stop:()=>{s.active=!1,n.resolve({value:void 0,done:!0}),a()}}}async forwardUplink(e,t,r,o){for(;;){const n=await Promise.race([t.next(),r]);if(!o())return!1;if(n.done===!0)break;this.worker.postMessage({t:"stream-uplink-item",id:e,value:n.value})}return this.worker.postMessage({t:"stream-uplink-end",id:e}),!0}async bootPayload(){const e=await this.fetch("/__boot__");if(!e.ok)throw new Error(`web-preview tunnel: boot payload failed with HTTP ${String(e.status)}: ${await e.text()}`);return await e.json()}async packageAssets(){const e=await this.fetch("/__assets__");if(!e.ok)throw new Error(`web-preview tunnel: package assets failed with HTTP ${String(e.status)}: ${await e.text()}`);return F(new Uint8Array(await e.arrayBuffer()))}async loadBundle(e){const t=await this.fetch(e);if(!t.ok)throw new Error(`web-preview tunnel: bundle ${e} failed with HTTP ${String(t.status)}`);const r=await q(await t.text(),e,this.fetch),o=URL.createObjectURL(new Blob([r],{type:"text/javascript"}));try{await new Promise((n,i)=>{const s=document.createElement("script");s.src=o,s.addEventListener("load",()=>{s.remove(),n()},{once:!0}),s.addEventListener("error",()=>{s.remove(),i(new Error(`web-preview tunnel: bundle ${e} failed to execute`))},{once:!0}),document.head.append(s)})}finally{URL.revokeObjectURL(o)}}rejectOnAbort(e,t){let r=()=>{};return{rejected:new Promise((o,n)=>{const i=()=>{n(this.abortRequest(e))};if(t.aborted){i();return}t.addEventListener("abort",i,{once:!0}),r=()=>{t.removeEventListener("abort",i)}}),release:r}}abortRequest(e){this.unary.delete(e);const t=this.bodyStreams.get(e);this.bodyStreams.delete(e),this.inFlight.delete(e),this.releases.delete(e),this.abortWorkerOperation(e);const r=new DOMException("The operation was aborted.","AbortError");return t?.error(r),r}observeStreamAbort(e,t){const r=()=>{this.abortRequest(e)};t.addEventListener("abort",r,{once:!0}),this.releases.set(e,()=>{t.removeEventListener("abort",r)})}releaseSignal(e){const t=this.releases.get(e);this.releases.delete(e),t?.()}cancelStream(e){this.releaseSignal(e),this.bodyStreams.delete(e),this.inFlight.delete(e),this.abortWorkerOperation(e)}abortWorkerOperation(e){const t={t:"abort",id:e};try{this.worker.postMessage(t)}catch{}}warnRefusal(e,t){console.warn(`web-preview tunnel: request ${String(e)} ${this.inFlight.get(e)??"(unknown request)"} → ${t}`)}receive(e){switch(e.t){case"res":{const t=this.unary.get(e.id);if(t===void 0)return;e.status>=B&&this.warnRefusal(e.id,`HTTP ${String(e.status)}${e.message===void 0?"":`: ${e.message}`}`),this.unary.delete(e.id),this.inFlight.delete(e.id);const r=H.has(e.status)?null:e.body??e.message??null;t.resolve(new Response(r,{status:e.status,headers:e.headers}));return}case"res-head":{const t=this.unary.get(e.id);if(t===void 0)return;this.unary.delete(e.id);const r=new ReadableStream({start:o=>{this.bodyStreams.set(e.id,o)},cancel:()=>{this.cancelStream(e.id)}});t.resolve(new Response(r,{status:e.status,headers:e.headers}));return}case"res-chunk":this.bodyStreams.get(e.id)?.enqueue(new Uint8Array(e.chunk));return;case"res-end":{const t=this.bodyStreams.get(e.id);if(t===void 0)return;this.bodyStreams.delete(e.id),this.inFlight.delete(e.id),this.releaseSignal(e.id),t.close();return}case"res-err":{const t=new Error(`web-preview tunnel: ${e.message}`);this.warnRefusal(e.id,`res-err: ${e.message}`);const r=this.unary.get(e.id);if(this.inFlight.delete(e.id),r!==void 0){this.unary.delete(e.id),r.reject(t);return}const o=this.bodyStreams.get(e.id);if(o===void 0)return;this.bodyStreams.delete(e.id),this.releaseSignal(e.id),o.error(t);return}case"view-text":I(e.path,e.text);return;case"stream-item":case"stream-end":case"stream-error":{const t=this.logicalStreams.get(e.id);if(t===void 0)return;t.inbox.push(e),e.t!=="stream-item"&&t.pump?.stop();return}default:throw new Error(`web-preview tunnel: unknown frame ${JSON.stringify(e)}`)}}};const m="none",Y="webfs",V="preview-fixture",G=`
  [data-preview-source-chooser] {
    position: fixed;
    inset: 0;
    z-index: 1200;
    display: grid;
    place-items: center;
    overflow: auto;
    padding: 24px;
    box-sizing: border-box;
    color: #0f1115;
    background: #fff;
    font-size: 14px;
    line-height: 22px;
  }
  [data-preview-source-card] {
    width: min(600px, 100%);
    max-height: calc(100dvh - 48px);
    box-sizing: border-box;
    padding: 28px;
    overflow-y: auto;
    border: 1px solid transparent;
    border-radius: 24px;
    background: #fff;
    box-shadow: 0 0 1px rgb(0 0 0 / 20%), 0 12px 32px rgb(0 0 0 / 8%);
  }
  [data-preview-source-card] h1 {
    margin: 0;
    font-size: 20px;
    line-height: 28px;
    font-weight: 500;
  }
  [data-preview-source-card] > p {
    margin: 8px 0 0;
    color: #61666b;
  }
  [data-preview-source-card] fieldset {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin: 24px 0 0;
    padding: 0;
    border: 0;
  }
  [data-preview-source-card] legend {
    margin: 0 0 8px;
    padding: 0 4px;
    color: #61666b;
    font-size: 13px;
    line-height: 20px;
    font-weight: 500;
  }
  [data-preview-source-option] {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    min-height: 56px;
    padding: 8px 12px 8px 8px;
    box-sizing: border-box;
    border: 1px solid transparent;
    border-radius: 12px;
    background: transparent;
    cursor: pointer;
    transition: background-color 120ms ease, border-color 120ms ease;
  }
  [data-preview-source-option]:hover:not(:has(input:disabled)),
  [data-preview-source-option]:has(input:checked) {
    background: rgb(38 49 72 / 6%);
  }
  [data-preview-source-option]:has(input:checked) {
    border-color: rgb(0 0 0 / 10%);
  }
  [data-preview-source-option]:has(input:disabled) {
    cursor: default;
    opacity: 0.4;
  }
  [data-preview-source-option] input {
    flex: none;
    width: 16px;
    height: 16px;
    margin: 4px 0 0;
    accent-color: #0f1115;
  }
  [data-preview-source-option] > span { flex: 1; min-width: 0; }
  [data-preview-source-option] strong {
    display: block;
    font-size: 14px;
    line-height: 24px;
    font-weight: 500;
  }
  [data-preview-source-option] strong + span {
    display: block;
    color: #81858c;
    font-size: 14px;
    line-height: 24px;
  }
  [data-preview-source-footer] {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px 16px;
    margin: 24px 0 0;
  }
  [data-preview-source-link] {
    color: #61666b;
    text-underline-offset: 3px;
  }
  [data-preview-source-link]:hover { color: #0f1115; }
  [data-preview-source-submit] {
    display: block;
    min-width: 120px;
    height: 36px;
    margin: 0 0 0 auto;
    padding: 0 14px;
    border: 0;
    border-radius: 18px;
    color: #fff;
    background: #0f1115;
    font-size: 14px;
    line-height: 22px;
    cursor: pointer;
    transition: background-color 120ms ease;
  }
  [data-preview-source-submit]:hover:not(:disabled) {
    background: #43454a;
  }
  [data-preview-source-submit]:focus-visible {
    outline: 2px solid rgb(0 0 0 / 16%);
    outline-offset: 2px;
  }
  [data-preview-source-submit]:disabled { cursor: not-allowed; opacity: 0.5; }
  @media (prefers-color-scheme: dark) {
    [data-preview-source-chooser] {
      color: #f9fafb;
      background: #151517;
    }
    [data-preview-source-card] { border-color: rgb(255 255 255 / 6%); background: #2c2c2e; }
    [data-preview-source-card] > p, [data-preview-source-card] legend { color: #cfd3d6; }
    [data-preview-source-option] strong + span { color: #adb2b8; }
    [data-preview-source-option]:hover:not(:has(input:disabled)),
    [data-preview-source-option]:has(input:checked) { background: rgb(255 255 255 / 8%); }
    [data-preview-source-option]:has(input:checked) { border-color: rgb(255 255 255 / 12%); }
    [data-preview-source-option] input { accent-color: #f9fafb; }
    [data-preview-source-link] { color: #cfd3d6; }
    [data-preview-source-link]:hover { color: #f9fafb; }
    [data-preview-source-submit] { color: #0f1115; background: #f9fafb; }
    [data-preview-source-submit]:hover:not(:disabled) { background: #ebeef2; }
    [data-preview-source-submit]:focus-visible { outline-color: rgb(255 255 255 / 20%); }
  }
  @media (max-width: 560px) {
    [data-preview-source-card] { padding: 24px; }
    [data-preview-source-submit] { width: 100%; }
  }
  @media (prefers-reduced-motion: reduce) {
    [data-preview-source-option], [data-preview-source-submit] { transition: none; }
  }
`,J={"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"};function v(e){return e.replace(/[&<>"']/g,t=>J[t]??t)}function Q(e,t){return`<label data-preview-source-option>
    <input type="radio" name="preview-source" value="${e.id}"${e.id===t?" checked":""}${e.disabled===!0?" disabled":""}>
    <span>
      <strong>${v(e.label)}</strong>
      <span>${v(e.description)}</span>
    </span>
  </label>`}function X(e,t){return e.map(r=>({id:r.id,label:r.label,description:r.description,overlays:r.overlays.map(o=>new URL(o,t))}))}async function K(e){const t=new URL(location.href).searchParams.get(V);if(t===m)return[];const r=await fetch(e);if(!r.ok)throw new Error(`preview source chooser: fixture manifest returned ${String(r.status)}`);const o=_(await r.json()),n=[{id:m,label:"Empty environment",description:"Load only the base runtime to verify first launch and workspace creation.",overlays:[]},...X(o.fixtures,e),{id:Y,label:"WebFS directory",description:"Requires directory access and will be available after the WebFS provider lands.",overlays:[],disabled:!0}];if(t!==null){const l=n.find(h=>h.id===t&&h.disabled!==!0);if(l===void 0)throw new Error(`preview source chooser: unknown or interactive source "${t}"`);return l.overlays}const i=document.getElementById("root");if(i===null)throw new Error("preview source chooser: missing #root");const s=o.defaultFixture??m,a=document.createElement("style");a.dataset.previewSourceStyle="",a.textContent=G,document.head.append(a);const c=document.createElement("main");c.dataset.previewSourceChooser="",c.innerHTML=`<form data-preview-source-card aria-labelledby="preview-source-title">
      <h1 id="preview-source-title">Choose Preview data</h1>
      <p>Data mounts before the Worker and application start. Refresh to choose again.</p>
      <fieldset>
        <legend>Filesystem source</legend>
        ${n.map(l=>Q(l,s)).join("")}
      </fieldset>
      <div data-preview-source-footer>
        ${o.links.map(l=>`<a data-preview-source-link href="${v(new URL(l.href,e).href)}">${v(l.label)}</a>`).join("")}
        <button data-preview-source-submit type="submit">Start Preview</button>
      </div>
    </form>`,i.prepend(c);const d=c.querySelector("[data-preview-source-card]");if(d===null)throw new Error("preview source chooser: form was not rendered");const p=await new Promise((l,h)=>{d.addEventListener("submit",R=>{R.preventDefault();const k=new FormData(d).get("preview-source");typeof k=="string"?l(k):h(new Error("preview source chooser: no source selected"))},{once:!0})}),u=n.find(l=>l.id===p&&l.disabled!==!0);if(u===void 0)throw new Error(`preview source chooser: unavailable source "${p}"`);return c.remove(),a.remove(),u.overlays}function y(){return globalThis.__DSH_BOOT_READY__??=Promise.withResolvers()}function Z(){y().promise.catch(()=>{})}async function ee(e={}){Z();const t=new URL(e.image??"vfs-image.tar.gz",document.baseURI),r=new URL(e.fixtureManifest??"fixtures.json",t);try{return{overlays:await K(r)}}catch(o){throw y().reject(o),o}}async function te(e,t){const r=y();r.promise.catch(()=>{});try{const o=new N(e);o.init(new URL(t?.image??"vfs-image.tar.gz",document.baseURI).href,(t?.overlays??[]).map(s=>new URL(s,document.baseURI).href));const[n,i]=await Promise.all([o.bootPayload(),o.packageAssets()]);return globalThis.__DSH_TRANSPORT__={fetch:(s,a)=>o.fetch(s,a),openStream:(s,a,c,d)=>o.open(s,a,c,d),loadBundle:s=>o.loadBundle(s),resolveAsset:i,ownsHost:!0},globalThis.__DSH_FILE_UPLOAD__={fetch:(s,a)=>o.fetch(s,a)},await A(n.injections,s=>o.loadBundle(s)),r.resolve(),{worker:e,tunnel:o,loadBundle:s=>o.loadBundle(s)}}catch(o){throw r.reject(o),o}}const S=`preview/${T}`,re=await ee({image:S});await te(new L({name:"dsh-host"}),{image:S,overlays:re.overlays});
//# sourceMappingURL=bootstrap-DfUsa8G4.js.map
