// Validate model tool arguments again on the server; JSON Schema is not an authorization boundary.
export function flowToolFailure(error) {
  const message=String(error?.message||'');
  const safe=(error?.publicError||Number.isInteger(error?.status))&&/[\u3400-\u9fff]/.test(message)&&!/(?:gh[opusr]_|github_pat_|bearer\s|sk-|token\s*[:=]|https?:\/\/|\/Users\/|\/home\/|\b(?:SELECT|INSERT|UPDATE|DELETE|SQLITE|D1_ERROR)\b)/i.test(message);
  return {error:safe?message.slice(0,240):'站内操作失败，本次没有取得该结果。请核对已有保存回执，不要猜测或补造数据。',...(error?.flowSaved===true?{saved:true}: {})};
}
export function validateFlowArguments(schema, value, label = '操作参数') {
  const fail = message => { throw Object.assign(new Error(message), {status:400, publicError:true}); };
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) fail(`${label}格式不正确。`);
    const keys = Object.keys(value);
    if (schema.minProperties && keys.length < schema.minProperties) fail('请提供需要修改的字段。');
    for (const key of schema.required || []) if (!Object.hasOwn(value,key)) fail(`缺少必填字段：${schema.properties[key]?.description || key}。`);
    for (const key of keys) {
      if (!Object.hasOwn(schema.properties,key) || ['__proto__','constructor','prototype'].includes(key)) fail('操作包含不支持的字段。');
      validateFlowArguments(schema.properties[key],value[key],schema.properties[key].description || key);
    }
  } else if (schema.type === 'array') {
    if(!Array.isArray(value)||schema.minItems!=null&&value.length<schema.minItems||schema.maxItems!=null&&value.length>schema.maxItems)fail(`${label}数量不正确。`);
    for(const item of value)validateFlowArguments(schema.items,item,label);
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || schema.maxLength != null && value.length > schema.maxLength || schema.minLength != null && value.trim().length < schema.minLength) fail(`${label}请填写有效文字。`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail(`${label}格式不正确。`);
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') fail(`${label}格式不正确。`);
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || schema.type === 'integer' && !Number.isSafeInteger(value) || schema.minimum != null && value < schema.minimum || schema.maximum != null && value > schema.maximum) fail(`${label}数值不正确。`);
  }
  if (schema.enum && !schema.enum.includes(value)) fail(`${label}不在支持的范围内。`);
}
