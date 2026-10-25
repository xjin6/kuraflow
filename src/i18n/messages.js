import ja from './locales/ja.js';
import en from './locales/en.js';
import vi from './locales/vi.js';
export default Object.fromEntries(Object.keys(ja).map(key=>[key,[ja[key],en[key],vi[key]]]));
