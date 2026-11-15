/* CDP 探针：验证 2.2.0 通知三视图的渲染与真实交互链路。
   用法：node tools/cdp-probe.js http://127.0.0.1:8765/index.html tools/notify-probe-expr.js */
(async () => {
  const A = window.StationApp;
  const out = { version: A && A.version, notifyLoaded: !!window.StationNotify };
  const $ = id => document.getElementById(id);
  const click = id => { const el = $(id); if (el) el.click(); };
  const setv = (id, v) => { const el = $(id); if (el) el.value = v; };
  const change = id => { const el = $(id); if (el) el.dispatchEvent(new Event('change', { bubbles: true })); };
  const submit = id => { const el = $(id); if (el) el.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); };
  const tick = () => new Promise(r => setTimeout(r, 180));
  const act = a => { const el = document.querySelector('[data-act="' + a + '"]'); if (el) el.click(); };

  /* 初始化站长账号 */
  click('btnGoSetup');
  setv('setupName', 'probe3'); setv('setupPw', 'abc123456'); setv('setupPw2', 'abc123456');
  click('btnSetup'); await tick();
  out.logged = A.auth.status().logged;

  /* 造两件带有效手机号的在库件 */
  const p1 = A.store.addParcel({ trackingNo: 'YT9000012345', recipient: '张三', phone: '13800138000' });
  const p2 = A.store.addParcel({ trackingNo: 'SF1234567890', recipient: '李四', phone: '13900139000' });
  out.parcels = [!!(p1 && p1.ok), !!(p2 && p2.ok)];

  /* ---- 通知中心 ---- */
  A.switchView('notify'); await tick();
  out.notify = {
    kpi: $('ntKpi') ? $('ntKpi').querySelectorAll('.kpi').length : 0,
    channel: ($('ntChannelState').textContent || '').slice(0, 60),
    vars: $('ntVarDesc') ? $('ntVarDesc').querySelectorAll('.chip').length : 0,
    historyRows: $('ntHistoryTable') ? $('ntHistoryTable').querySelectorAll('tbody tr').length : 0,
    perm: window.StationNotify.permState()
  };
  setv('ntSetSignature', '【测试驿站】'); setv('ntSetBatchLimit', '30');
  act('n-saveSettings'); await tick();
  out.savedSignature = A.store.raw().extras.notify.settings.signature;
  out.savedBatchLimit = A.store.raw().extras.notify.settings.batchLimit;

  /* 微信取件文案 + 二维码海报 + 复制 */
  setv('ntWechatScope', 'in');
  act('n-wechatGen'); await tick();
  out.wechat = {
    text: ($('ntWechatText').value || '').slice(0, 50),
    qr: ($('ntQrBox').innerHTML || '').indexOf('<svg') >= 0,
    qrText: window.StationNotify.state.qrText
  };
  act('n-wechatCopy'); await tick();

  /* 延迟发送队列 */
  setv('ntQueueScope', 'in'); setv('ntQueueKw', '');
  act('n-queueAdd'); await tick();
  out.queueAdded = A.store.raw().extras.notify.queue.length;
  out.queueRows = $('ntQueue') ? $('ntQueue').querySelectorAll('.strip-item').length : 0;
  act('n-queueClear'); await tick();
  const okBtn = document.querySelector('[data-modal="ok"]'); if (okBtn) okBtn.click(); await tick();
  out.queueCleared = A.store.raw().extras.notify.queue.length;

  /* ---- 短信群发 ---- */
  A.switchView('sms'); await tick();
  setv('smsScope', 'in'); setv('smsKw', '');
  act('n-smsPreview'); await tick();
  out.sms = {
    pool: $('smsPool') ? $('smsPool').querySelectorAll('.strip-item').length : 0,
    countInfo: ($('smsCountInfo').textContent || '').slice(0, 80),
    bubbles: $('smsPreviewBox') ? $('smsPreviewBox').querySelectorAll('.sms-bubble').length : 0,
    templateOptions: $('smsTemplate') ? $('smsTemplate').options.length : 0
  };
  setv('smsCustom', '{sign}{name}您好，货号{goods}到件'); change('smsCustom'); await tick();
  out.sms.customRendered = ($('smsPreviewBox').textContent || '').indexOf('【测试驿站】') >= 0;
  setv('smsTplName', '探针模板'); setv('smsTplBody', '{name}/{goods}');
  submit('formSmsTpl'); await tick();
  out.sms.templates = A.store.raw().extras.notify.templates.length;
  out.sms.tplList = $('smsTplList') ? $('smsTplList').querySelectorAll('.strip-item').length : 0;

  /* ---- 电话通知 ---- */
  A.switchView('calls'); await tick();
  setv('callScope', 'in'); setv('callKw', '');
  act('n-groupBuild'); await tick();
  out.calls = {
    queue: $('callQueueBox') ? $('callQueueBox').querySelectorAll('.strip-item').length : 0,
    progress: ($('callQueueCount').textContent || '').slice(0, 40),
    voiceOptions: $('callVoiceTpl') ? $('callVoiceTpl').options.length : 0
  };
  setv('callLogPhone', '13800138000'); setv('callLogName', '张三');
  setv('callLogKind', 'missed'); setv('callLogNote', '未接回拨');
  act('n-callLogAdd'); await tick();
  out.calls.logRows = $('callLogTable') ? $('callLogTable').querySelectorAll('tbody tr').length : 0;
  out.calls.logSaved = A.store.raw().extras.notify.calls.length;
  setv('callPhone', '13800138000');
  act('n-callMatch'); await tick();
  out.calls.matched = $('callMatchBox') ? $('callMatchBox').querySelectorAll('.strip-item').length : 0;
  act('n-voiceFromTpl'); await tick();
  out.calls.voiceText = ($('callVoiceText').value || '').slice(0, 30);

  /* 回执链路（模拟原生 onReceipt） */
  const N = window.StationNotify, nh = A.store.raw().extras.notify.history;
  nh.push({ id: 'probe-rec', nativeId: 'sm-probe', kind: 'sms', phone: '13800138000', text: 'x', status: 'sent', at: new Date().toISOString() });
  N.onReceipt('sm-probe', 'delivered', '');
  out.receipt = nh.filter(x => x.id === 'probe-rec')[0].status;

  out.bootErrors = (window.StationBoot && window.StationBoot.errors && window.StationBoot.errors()) || [];
  out.viewErrors = (window.StationBoot && window.StationBoot.errors && window.StationBoot.errors())
    .filter(e => String(e).indexOf('渲染') >= 0);
  out.data = {
    settings: A.store.raw().extras.notify.settings.channel,
    history: A.store.raw().extras.notify.history.length,
    calls: A.store.raw().extras.notify.calls.length,
    templates: A.store.raw().extras.notify.templates.length
  };
  return out;
})()
