// Public bundles contain no business records. These bindings are hydrated only
// after the server has checked the signed-in user's permissions.
export const materialProducts = [];
export const materialStores = [];
export const materialPrices = {};
export const materialQuoteMeta = {};
export const materialDocuments = [];
export const exampleOrderLines = [];
export let company = { name: '倉流' };
export let materialSummary = { salesCount: 0, costCount: 0, costConflicts: [], rules: [], sourceFiles: [] };
export let materialCosts = [];
export let procurementAttachment = [];
export const businessCategories = ['冷冻品', '常温品', '蔬菜品', '饮品', '干调类', '代买品', '其他食材'];

export function hydrateMaterialSources(data = {}) {
  company = data.company || company;
  materialSummary = { ...materialSummary, ...(data.materialSummary || {}) };
  materialCosts = data.materialCosts || [];
  procurementAttachment = data.procurementAttachment || [];
}
