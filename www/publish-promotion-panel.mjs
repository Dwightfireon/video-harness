/* 商业声明 UI：选填资料留空就不传；与作品表单统一保存，不单独授权投稿。 */
const $ = id => document.getElementById(id);
export function attachPublishPromotion({ request, onEdit, isBusy = () => false }) {
  let catalog = null, reading = false;
  const read = () => ({ enabled: $('pubPromotion').checked, brandName: $('pubPromotionBrand').value.trim(),
    industryId: Number($('pubPromotionIndustry').value) || null,
    showTypes: [...$('pubPromotionTypes').querySelectorAll('input:checked')].map(input => Number(input.value)) });
  const describe = (form = read()) => form.enabled ? '含商业推广 · 声明「内容含营销信息」' + (form.brandName ? ` · ${form.brandName}` : '（品牌/网站名称未填）') : '未勾选商业推广';
  function paint() {
    $('pubPromotionDetails').hidden = !$('pubPromotion').checked;
  }
  function renderOptions(form = read()) {
    const select = $('pubPromotionIndustry'); select.replaceChildren(new Option('不填写', ''));
    const industries = [...(catalog?.industries || [])];
    if (form.industryId && !industries.some(item => item.id === form.industryId)) industries.push({ id: form.industryId, name: `已保存行业（${form.industryId}）` });
    for (const item of industries) select.add(new Option(item.name, String(item.id)));
    select.value = form.industryId ? String(form.industryId) : '';
    const box = $('pubPromotionTypes'); box.replaceChildren();
    const types = [...(catalog?.showTypes || [])];
    for (const id of form.showTypes || []) if (!types.some(item => item.id === id)) types.push({ id, name: `已保存形式（${id}）` });
    for (const item of types) {
      const label = document.createElement('label'), input = document.createElement('input');
      input.type = 'checkbox'; input.value = String(item.id); input.checked = form.showTypes.includes(item.id);
      input.disabled = isBusy();
      input.onchange = edit;
      label.append(input, document.createTextNode(item.name)); box.append(label);
    }
  }
  async function loadCatalog() {
    if (reading || catalog) return;
    reading = true; $('pubPromotionCatalogRetry').hidden = true;
    $('pubPromotionCatalogStatus').textContent = '正在读取 B 站行业和推广形式；无需填写也可继续。';
    try {
      const data = await request('/promotion-catalog');
      if (!Array.isArray(data.industries) || !Array.isArray(data.showTypes)) throw new Error('选项响应无效');
      catalog = data; renderOptions();
      $('pubPromotionCatalogStatus').textContent = data.industries.length || data.showTypes.length
        ? '选项来自 B 站。未选行业和形式时不传这些字段。' : 'B 站未返回补充选项，可以留空。';
    } catch (error) {
      $('pubPromotionCatalogStatus').textContent = '补充选项暂不可用：' + error.message + '。可以留空，不影响保存声明。';
      $('pubPromotionCatalogRetry').hidden = false;
    } finally { reading = false; }
  }
  function edit() { paint(); onEdit(); }
  $('pubPromotion').onchange = () => { edit(); if ($('pubPromotion').checked) void loadCatalog(); };
  $('pubPromotionBrand').oninput = edit;
  $('pubPromotionIndustry').onchange = edit;
  $('pubPromotionCatalogRetry').onclick = () => loadCatalog();
  return { read, describe,
    setProject(id, promotion = {}) {
      const form = { enabled: promotion.enabled === true, brandName: promotion.brandName || '', industryId: promotion.industryId || null, showTypes: promotion.showTypes || [] };
      $('pubPromotion').checked = form.enabled; $('pubPromotionBrand').value = form.brandName;
      renderOptions(form); paint();
      if (form.enabled) void loadCatalog();
    } };
}
