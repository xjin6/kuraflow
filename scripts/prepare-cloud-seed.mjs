import fs from 'node:fs/promises';
import {KitchenModel} from '../data.js';
import {company,materialCosts,procurementAttachment,materialSummary} from '../business-data.js';
const tenantId='maido-kitchen';
const m=new KitchenModel();m.storage=null;m.reset();
m.state.orders=[];m.state.cart={};m.state.cartUnits={};m.state.reminders=[];m.state.priceHistory=[];
m.state.settings.companyName=company.name;
m.state.privateMaterials={company,materialCosts,procurementAttachment,materialSummary:{...materialSummary,sourceFiles:[]}};
const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
const {products,orders,documents,privateMaterials,...core}=m.state;
const lines=[`INSERT INTO tenants(id,name,core_json,revision) VALUES (${quote(tenantId)},${quote(company.name)},${quote(JSON.stringify(core))},0);`];
for(const p of products)lines.push(`INSERT INTO products(tenant_id,id,data_json) VALUES (${quote(tenantId)},${quote(p.id)},${quote(JSON.stringify(p))});`);
for(const d of documents)lines.push(`INSERT INTO documents(tenant_id,id,store_id,data_json,created_at) VALUES (${quote(tenantId)},${quote(d.id)},${quote(d.storeId)},${quote(JSON.stringify(d))},${quote(d.date+'T00:00:00+09:00')});`);
// Private materials statement is finalized against the repository schema before use.
await fs.mkdir('private-deploy',{recursive:true,mode:0o700});
await fs.writeFile('private-deploy/seed-state.json',JSON.stringify({tenantId,state:m.state}),{mode:0o600});
await fs.writeFile('private-deploy/seed.sql',lines.join('\n'),{mode:0o600});
console.log('Private seed prepared; no cloud writes. Demo orders excluded.');
