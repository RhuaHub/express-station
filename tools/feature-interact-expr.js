/* CDP 探针表达式：验证 2.1.0 新功能的真实写入与交互链路。
   用法：node tools/cdp-probe.js http://127.0.0.1:8765/index.html tools/feature-interact-expr.js */
(async () => {
  const A = window.StationApp;
  const out = { version: A && A.version };
  const $ = id => document.getElementById(id);
  const click = id => { const el = $(id); if (el) el.click(); };
  const setv = (id, v) => { const el = $(id); if (el) el.value = v; };
  const submit = id => { const el = $(id); if (el) el.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); };
  const tick = () => new Promise(r => setTimeout(r, 160));
  const act = a => { const el = document.querySelector('[data-act="' + a + '"]'); if (el) el.click(); };

  click('btnGoSetup');
  setv('setupName', 'probe2'); setv('setupPw', 'abc123456'); setv('setupPw2', 'abc123456');
  click('btnSetup'); await tick();
  out.logged = A.auth.status().logged;

  /* 账本：充值 -> 余额 / 流水 */
  A.switchView('wallet'); await tick();
  setv('walAmount', '100'); setv('walNote', '');
  submit('formRecharge'); await tick();
  out.balanceAfterRecharge = $('walBalance').textContent;
  out.walletRows = $('walTable').querySelectorAll('tbody tr').length;
  setv('walFeeIn', '0.5'); setv('walFeeOut', '0.5'); submit('formFee'); await tick();

  /* 服务中心：反馈写入 + 回复弹窗 */
  A.switchView('service'); await tick();
  setv('fbText', '测试反馈：希望支持批量打印'); setv('fbContact', 'probe');
  submit('formFeedback'); await tick();
  out.feedbackCount = window.StationExtras ? null : null;
  out.feedbackList = ($('fbList').textContent || '').slice(0, 40);
  const replyBtn = document.querySelector('[data-act="x-fbReply"]');
  if (replyBtn) { replyBtn.click(); await tick(); const ok = document.querySelector('[data-modal="ok"]'); if (ok) { setv('fbReplyText', '已记录'); ok.click(); await tick(); } }
  out.feedbackReplied = ($('fbList').textContent || '').indexOf('已回复') >= 0;

  /* 驿站档案：保存资料 + 生成二维码海报 */
  A.switchView('station'); await tick();
  setv('stName', '测试驿站'); setv('stAddress', '测试路 1 号'); setv('stServices', '代收包裹\n上门取件');
  submit('formStation'); await tick();
  out.stationState = $('stationState').textContent;
  setv('stQrText', 'A01010023'); act('x-stQr'); await tick();
  out.qrPoster = ($('stQrBox').innerHTML || '').indexOf('<svg') >= 0;

  /* 打印模板：保存一套 */
  A.switchView('print'); await tick();
  setv('tplName', '小标签'); act('x-tplSave'); await tick();
  out.tplOptions = $('tplSelect').options.length;

  /* 出库任务：先造一件在库件，再筛选 / 建任务 / 整批出库 */
  const added = A.store.addParcel({ trackingNo: 'YT9000012345', recipient: '测试' });
  out.parcelAdded = !!(added && added.ok);
  A.switchView('tasks'); await tick();
  act('x-taskPreview'); await tick();
  const cb = document.querySelector('[data-task-check]');
  if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); await tick(); }
  setv('taskName', '晚高峰'); submit('formTask'); await tick();
  out.taskList = ($('taskList').textContent || '').slice(0, 40);
  out.taskDetailRows = $('taskDetailTable').querySelectorAll('tbody tr').length;
  act('x-taskCheckout'); await tick();
  const okBtn = document.querySelector('[data-modal="ok"]');
  if (okBtn) okBtn.click();
  await tick(); await tick();
  out.taskDone = ($('taskList').textContent || '').indexOf('已完成') >= 0;
  const ps = A.store.listParcels({ status: 'all' });
  out.parcelStatus = ps.length ? ps[0].status : null;
  out.bootErrors = (window.StationBoot && window.StationBoot.errors && window.StationBoot.errors()) || [];
  out.extras = {
    tasks: A.store.raw().extras.tasks.length,
    wallet: A.store.raw().extras.wallet.records.length,
    feedbacks: A.store.raw().extras.feedbacks.length,
    templates: A.store.raw().extras.templates.length
  };
  return out;
})()
