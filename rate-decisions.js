/* Shared rate-approval rules, used by the Rate Approvals queue, the rate request page and the
   application page so all three agree on who may sign off and what a decision does.

   Rates between the Manager and Standard rate are a Sales Manager's call; anything under
   the Manager rate needs the Head of Sales. Each approver sees and decides only the
   requests at their own level — the Head does not review the Manager's requests.

   What an approver decides is an approval request: one application at one approval level.
   Every rate line on the application that needs that level — across all of its services —
   sits in the same request and is approved or rejected together. An application that has
   lines in both bands therefore produces two requests, one for each approver. */
window.KashierRates = (function () {
  const ROLES = {
    sales:   { label: 'Salesperson',     name: 'Aya Muhammed', initials: 'AM', approves: [] },
    manager: { label: 'Sales Manager', name: 'Nadia Salah',  initials: 'NS', approves: ['manager'] },
    head:    { label: 'Head of Sales',   name: 'Tarek Fahmy',  initials: 'TF', approves: ['head'] },
    // Works submitted applications in the Merchant module; approves no rates.
    onboarding: { label: 'Onboarding Team', name: 'Rana Adel', initials: 'RA', approves: [] },
  };
  const TIER_LABEL = { manager: 'Manager approval', head: 'Head approval' };
  const TIER_OWNER = { manager: 'Sales Manager', head: 'Head of Sales' };

  function readStore(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) { return {}; }
  }
  function writeStore(key, obj) {
    try { localStorage.setItem(key, JSON.stringify(obj)); } catch (e) { /* storage unavailable */ }
  }

  function getRole() {
    try {
      const saved = localStorage.getItem('kashierDemoRole');
      if (saved && ROLES[saved]) return saved;
    } catch (e) { /* storage unavailable */ }
    return 'sales';
  }
  function setRole(role) {
    if (!ROLES[role]) return;
    try { localStorage.setItem('kashierDemoRole', role); } catch (e) { /* storage unavailable */ }
  }

  function decisionsFor(appId) { return readStore('kashierRateDecisions')[appId] || {}; }
  function canRoleAct(role, tier) { return ROLES[role].approves.indexOf(tier) !== -1; }

  /* Where the application sits once a decision lands. Approvers review every requested rate
     — rejecting one does not stop the others being reviewed. While any rate is still open the
     application waits on rate approval; once all are reviewed it goes back to the salesperson
     if one or more were rejected, or on to Underwriting Review if every rate was approved. */
  function statusFor(requests, decisions) {
    const rejected = requests.filter(r => decisions[r.id] && decisions[r.id].decision === 'rejected');
    const pending = requests.filter(r => !decisions[r.id]);
    if (pending.length) return 'pending-rate-approval';
    if (rejected.length) return 'returned-to-sales';
    return 'pending-onboarding-review';
  }
  const LEAD_STATUS = {
    'returned-to-sales': 'application',
    'pending-onboarding-review': 'onboarding-review',
    'pending-rate-approval': 'rate-approval',
  };

  /* Write one decision onto a set of rate lines, then carry the consequence through to the
     application and its lead once. */
  function applyDecision(app, lines, opts) {
    const all = readStore('kashierRateDecisions');
    const decisions = all[app.id] || {};
    const entry = {
      decision: opts.decision,
      reason: opts.reason || '',
      by: ROLES[opts.role].name,
      roleLabel: ROLES[opts.role].label,
      ts: new Date().toISOString(),
    };
    lines.forEach(r => { decisions[r.id] = entry; });
    all[app.id] = decisions;
    writeStore('kashierRateDecisions', all);

    const status = statusFor(app.requests, decisions);
    const statuses = readStore('kashierAppStatus');
    statuses[app.id] = status;
    writeStore('kashierAppStatus', statuses);

    if (app.leadId) {
      const leadStatuses = readStore('kashierLeadStatusOverrides');
      leadStatuses[app.leadId] = LEAD_STATUS[status];
      writeStore('kashierLeadStatusOverrides', leadStatuses);

      // Leave a trail on the lead so the salesperson sees why it came back.
      const rejected = app.requests.filter(r => decisions[r.id] && decisions[r.id].decision === 'rejected');
      const notes = readStore('kashierLeadReturnNote');
      if (status === 'returned-to-sales') {
        const byReason = {};
        rejected.forEach(r => {
          const d = decisions[r.id];
          const key = d.by + '|' + d.reason;
          (byReason[key] = byReason[key] || { d: d, rates: [] }).rates.push(
            [r.service, r.bank].filter(Boolean).join(' · ') + ' — ' + r.rate);
        });
        notes[app.leadId] = {
          ts: new Date().toISOString(),
          text: Object.keys(byReason).map(k => {
            const g = byReason[k];
            return g.rates.join(', ') + ' rejected by ' + g.d.by + ': ' + g.d.reason;
          }).join(' | '),
        };
      } else {
        delete notes[app.leadId];
      }
      writeStore('kashierLeadReturnNote', notes);
    }
    return status;
  }

  /* Decide a whole approval request — every still-undecided line at that level. */
  function recordRequestDecision(opts) {
    const app = opts.app;
    if (!canRoleAct(opts.role, opts.tier)) return null;
    const decisions = decisionsFor(app.id);
    if (readStore('kashierSupersededApplications')[app.id]) return null;
    const lines = app.requests.filter(r => r.tier === opts.tier && !decisions[r.id]);
    if (!lines.length) return null;
    return { status: applyDecision(app, lines, opts), lines: lines };
  }

  /* Decide a single rate line from inside its request. Other rates stay open for review;
     the application goes back to the salesperson once every rate has been reviewed. */
  function recordDecision(opts) {
    const app = opts.app;
    const req = app.requests.filter(r => r.id === opts.reqId)[0];
    if (!req || !canRoleAct(opts.role, req.tier)) return null;
    const decisions = decisionsFor(app.id);
    if (decisions[req.id]) return null;
    if (readStore('kashierSupersededApplications')[app.id]) return null;
    if (opts.decision === 'rejected' && !String(opts.reason || '').trim()) return null;
    return { status: applyDecision(app, [req], opts), request: req };
  }

  /* Applications carrying rate requests. Real ones are the tracking links the onboarding
     page stored on submit; the seeded pair stands in for applications that were already
     sitting with the Rate Approval desk before this demo started. */
  const SEEDED = [
    {
      id: 'APP-00000001', leadId: 'L-001', website: 'https://cairofresh.com', biz: 'Cairo Fresh Market', actor: 'Mostafa Khaled',
      ts: '2026-09-06T14:20:00.000Z',
      summary: {
        email: 'ops@cairofresh.eg', phone: '+20 100 123 4567',
        entity: 'Registered Business', industry: 'Retail & E-commerce',
        services: ['Online Card', 'Online Bank Installments'],
        serviceConfigs: [
          { service: 'Online Card', configs: [{ bank: 'Bank Misr', module: 'PSP' }] },
          { service: 'Online Bank Installments', configs: [{ bank: 'National Bank of Egypt', module: 'PSP' }] },
        ],
        posTerminals: '', docsDone: '6', docsTotal: '6',
      },
      documents: [
        { name: 'Commercial Register', file: 'commercial-register.pdf' },
        { name: 'Tax Card', file: 'tax-card.pdf' },
        { name: 'Owner National ID', file: 'owner-id-front-back.pdf' },
        { name: 'Bank Account Letter', file: 'bank-misr-letter.pdf' },
        { name: 'Signed Merchant Agreement', file: 'merchant-agreement-signed.pdf' },
        { name: 'Shop Front Photo', file: 'shop-front.jpg' },
      ],
      requests: [
        { id: 'Online Card::Bank Misr::national-onus', service: 'Online Card', bank: 'Bank Misr',
          rate: 'National — On-us rate', tier: 'manager', from: 1, to: 1.5, requested: 1.2, standard: 1.5, requestedFee: 1, standardFee: 2,
          note: 'Processes 450K EGP/month across 3 branches — matching the rate their current provider quoted.' },
        { id: 'Online Card::Bank Misr::meeza-onus', service: 'Online Card', bank: 'Bank Misr',
          rate: 'Meeza — On-us rate', tier: 'manager', from: 0.9, to: 1.2, requested: 1, standard: 1.2, requestedFee: 1.5, standardFee: 1.5,
          note: 'Most of their in-store customers pay with Meeza cards.' },
        { id: 'Online Bank Installments::National Bank of Egypt::6-month', service: 'Online Bank Installments', bank: 'National Bank of Egypt',
          rate: '6-month plan', tier: 'manager', from: 2.5, to: 3, requested: 2.75, standard: 3, requestedFee: 2, standardFee: 2,
          note: 'Installments on large grocery baskets are a key part of their loyalty programme.' },
      ],
    },
    {
      id: 'APP-00000007', leadId: 'L-007', website: 'https://mansouratech.io', biz: 'Mansoura Tech Studio', actor: 'Mostafa Khaled',
      ts: '2026-09-05T11:00:00.000Z',
      summary: {
        email: 'karim@mansouratech.eg', phone: '+20 122 998 7766',
        entity: 'Registered Business', industry: 'Software & SaaS',
        services: ['Online Card', 'Online Wallet'],
        serviceConfigs: [
          { service: 'Online Card', configs: [{ bank: 'National Bank of Egypt', module: 'PF' }] },
          { service: 'Online Wallet', configs: [{ bank: '', module: 'PF' }] },
        ],
        posTerminals: '', docsDone: '7', docsTotal: '7',
      },
      documents: [
        { name: 'Commercial Register', file: 'cr-mansoura-tech.pdf' },
        { name: 'Tax Card', file: 'tax-card.pdf' },
        { name: 'Owner National ID', file: 'karim-nabil-id.pdf' },
        { name: 'Bank Account Letter', file: 'qnb-account-letter.pdf' },
        { name: 'Signed Merchant Agreement', file: 'agreement-signed.pdf' },
        { name: 'Website Terms & Refund Policy', file: 'terms-and-refunds.pdf' },
        { name: 'Wallet Service Addendum', file: 'wallet-addendum.pdf' },
      ],
      requests: [
        { id: 'Online Card::National Bank of Egypt::national-offus', service: 'Online Card', bank: 'National Bank of Egypt',
          rate: 'National — Off-us rate', tier: 'head', from: 1, to: 1.5, requested: 0.9, standard: 2, requestedFee: 2, standardFee: 2,
          note: 'Subscription product on thin margins — Karim negotiated this rate before signing.' },
        { id: 'Online Wallet::::wallet', service: 'Online Wallet', bank: '',
          rate: 'Wallet rate', tier: 'head', from: 1, to: 1.5, requested: 0.8, standard: 2, requestedFee: 1, standardFee: 1.5,
          note: 'Their app users top up by wallet — the same deal as cards keeps checkout consistent.' },
        { id: 'Online Card::National Bank of Egypt::intl-EGP', service: 'Online Card', bank: 'National Bank of Egypt',
          rate: 'International rate — EGP', tier: 'manager', from: 2, to: 2.5, requested: 2.2, standard: 2.5, requestedFee: 1.5, standardFee: 3,
          note: 'Half their volume is international clients paying in USD.' },
      ],
    },
    // Returned to the salesperson: reviewed, with rates rejected — waiting on a resubmission.
    {
      id: 'APP-00000005', leadId: 'L-005', website: 'https://gizalearning.edu', biz: 'Giza Learning Hub', actor: 'Mostafa Khaled',
      ts: '2026-09-07T09:10:00.000Z',
      summary: {
        email: 'omar@gizalearning.edu', phone: '+20 106 567 8901',
        entity: 'Professional Business', industry: 'Education',
        services: ['Online Card', 'Online Bank Installments'],
        serviceConfigs: [
          { service: 'Online Card', configs: [{ bank: 'Bank Misr', module: 'PSP' }] },
          { service: 'Online Bank Installments', configs: [{ bank: 'Bank Misr', module: 'PSP' }] },
        ],
        posTerminals: '', docsDone: '5', docsTotal: '5',
      },
      documents: [
        { name: 'Commercial Register', file: 'giza-learning-cr.pdf' },
        { name: 'Tax Card', file: 'tax-card.pdf' },
        { name: 'Owner National ID', file: 'omar-khalil-id.pdf' },
        { name: 'Bank Account Letter', file: 'cib-account-letter.pdf' },
        { name: 'Signed Merchant Agreement', file: 'agreement-signed.pdf' },
      ],
      requests: [
        { id: 'Online Card::Bank Misr::national-onus', service: 'Online Card', bank: 'Bank Misr',
          rate: 'National — On-us rate', tier: 'manager', from: 1, to: 1.5, requested: 1.25, standard: 1.5, requestedFee: 1.5, standardFee: 2,
          note: 'Tuition payments peak at the start of each term — a partner referral with steady volume.' },
        { id: 'Online Card::Bank Misr::national-offus', service: 'Online Card', bank: 'Bank Misr',
          rate: 'National — Off-us rate', tier: 'manager', from: 1, to: 1.5, requested: 1.1, standard: 1.5, requestedFee: 1, standardFee: 2,
          note: 'Most parents pay with cards from other banks.' },
        { id: 'Online Bank Installments::Bank Misr::12-month', service: 'Online Bank Installments', bank: 'Bank Misr',
          rate: '12-month plan', tier: 'head', from: 3, to: 4, requested: 2.5, standard: 4.5, requestedFee: 2, standardFee: 2,
          note: 'Parents split yearly tuition into 12 installments — the partner asked for this rate.' },
      ],
      seedDecisions: {
        'Online Card::Bank Misr::national-onus': { decision: 'approved', reason: '', by: 'Nadia Salah', roleLabel: 'Sales Manager', ts: '2026-09-07T13:00:00.000Z' },
        'Online Card::Bank Misr::national-offus': { decision: 'rejected', reason: 'Off-us at 1.1% is below cost for this volume — 1.35% is the lowest we can offer.', by: 'Nadia Salah', roleLabel: 'Sales Manager', ts: '2026-09-07T13:05:00.000Z' },
        'Online Bank Installments::Bank Misr::12-month': { decision: 'rejected', reason: 'A 12-month plan under 3% is not viable — resubmit at 3% or above.', by: 'Tarek Fahmy', roleLabel: 'Head of Sales', ts: '2026-09-08T10:30:00.000Z' },
      },
    },
    // Applications already past rate approval, one at each onboarding stage.
    {
      id: 'APP-00000006', leadId: 'L-006', website: 'https://zamalekhotel.com', biz: 'Zamalek Boutique Hotel', actor: 'Mostafa Khaled',
      ts: '2026-09-04T10:15:00.000Z', seedAccount: { status: 'submitted' },
      summary: {
        email: 'dina@zamalekhotel.com', phone: '+20 128 678 9012',
        entity: 'Registered Business', industry: 'Travel & Tourism',
        services: ['Online Card', 'POS Card'],
        serviceConfigs: [
          { service: 'Online Card', configs: [{ bank: 'National Bank of Egypt', module: 'PSP' }] },
          { service: 'POS Card', configs: [{ bank: 'National Bank of Egypt', module: 'PSP' }] },
        ],
        posTerminals: '2', docsDone: '6', docsTotal: '6',
      },
      documents: [
        { name: 'Commercial Register', file: 'zamalek-hotel-cr.pdf' },
        { name: 'Tax Card', file: 'tax-card.pdf' },
        { name: 'Tourism Licence', file: 'ministry-tourism-licence.pdf' },
        { name: 'Owner National ID', file: 'dina-fathy-id.pdf' },
        { name: 'Bank Account Letter', file: 'nbe-account-letter.pdf' },
        { name: 'Signed Merchant Agreement', file: 'agreement-signed.pdf' },
      ],
      requests: [],
    },
    {
      id: 'APP-00000010', leadId: 'L-010', website: 'https://aswanrealty.com', biz: 'Aswan Realty Partners', actor: 'Mostafa Khaled',
      ts: '2026-09-02T13:40:00.000Z',
      seedAccount: { status: 'pending-configurations', by: 'Rana Adel', ts: '2026-09-07T09:30:00.000Z' },
      summary: {
        email: 'farida@aswanrealty.com', phone: '+20 111 012 3456',
        entity: 'Registered Business', industry: 'Real Estate',
        services: ['Online Card', 'Online Bank Installments'],
        serviceConfigs: [
          { service: 'Online Card', configs: [{ bank: 'Bank Misr', module: 'PF' }] },
          { service: 'Online Bank Installments', configs: [{ bank: 'Bank Misr', module: 'PF' }, { bank: 'National Bank of Egypt', module: 'PF' }] },
        ],
        posTerminals: '', docsDone: '5', docsTotal: '5',
      },
      documents: [
        { name: 'Commercial Register', file: 'aswan-realty-cr.pdf' },
        { name: 'Tax Card', file: 'tax-card.pdf' },
        { name: 'Owner National ID', file: 'farida-gamal-id.pdf' },
        { name: 'Bank Account Letter', file: 'banque-misr-letter.pdf' },
        { name: 'Signed Merchant Agreement', file: 'agreement-signed.pdf' },
      ],
      requests: [],
    },
    {
      id: 'APP-00000004', leadId: 'L-004', website: 'https://alexautoparts.com', biz: 'Alexandria Auto Parts', actor: 'Mostafa Khaled',
      ts: '2026-08-18T08:50:00.000Z',
      seedAccount: { status: 'live', by: 'Rana Adel', ts: '2026-08-30T15:05:00.000Z', approvedTs: '2026-08-22T11:20:00.000Z' },
      summary: {
        email: 'salma@alexautoparts.com', phone: '+20 155 456 7890',
        entity: 'Registered Business', industry: 'Automotive',
        services: ['Online Card', 'POS Card'],
        serviceConfigs: [
          { service: 'Online Card', configs: [{ bank: 'National Bank of Egypt', module: 'PSP' }] },
          { service: 'POS Card', configs: [{ bank: 'National Bank of Egypt', module: 'PSP' }] },
        ],
        posTerminals: '3', docsDone: '5', docsTotal: '5',
      },
      documents: [
        { name: 'Commercial Register', file: 'alex-auto-cr.pdf' },
        { name: 'Tax Card', file: 'tax-card.pdf' },
        { name: 'Owner National ID', file: 'salma-reda-id.pdf' },
        { name: 'Bank Account Letter', file: 'qnb-letter.pdf' },
        { name: 'Signed Merchant Agreement', file: 'agreement-signed.pdf' },
      ],
      requests: [],
    },
  ];


  /* A seeded application that arrives already reviewed writes its decisions once, the same
     way a real decision would, so the lead shows up as returned. Nothing is written again
     once the application has decisions of its own (or was resubmitted). */
  /* QNB and CIB were removed as institutions: decisions already saved against their rate lines
     follow those lines to the banks the seeded applications now use. */
  (function migrateRemovedBanks() {
    const all = readStore('kashierRateDecisions');
    const to = { QNB: 'National Bank of Egypt', CIB: 'Bank Misr' };
    let changed = false;
    Object.keys(all).forEach(appId => Object.keys(all[appId]).forEach(id => {
      const m = id.match(/^(.*?)::(QNB|CIB)::(.*)$/);
      if (!m) return;
      all[appId][m[1] + '::' + to[m[2]] + '::' + m[3]] = all[appId][id];
      delete all[appId][id];
      changed = true;
    }));
    if (changed) writeStore('kashierRateDecisions', all);
  })();

  (function seedReviewedApplications() {
    const all = readStore('kashierRateDecisions');
    SEEDED.forEach(app => {
      if (!app.seedDecisions || all[app.id]) return;
      all[app.id] = app.seedDecisions;
      const status = statusFor(app.requests, app.seedDecisions);
      const statuses = readStore('kashierAppStatus');
      statuses[app.id] = status;
      writeStore('kashierAppStatus', statuses);
      const leadStatuses = readStore('kashierLeadStatusOverrides');
      leadStatuses[app.leadId] = LEAD_STATUS[status];
      writeStore('kashierLeadStatusOverrides', leadStatuses);
      if (status === 'returned-to-sales') {
        const notes = readStore('kashierLeadReturnNote');
        const rejected = app.requests.filter(r => app.seedDecisions[r.id] && app.seedDecisions[r.id].decision === 'rejected');
        notes[app.leadId] = {
          ts: rejected.map(r => app.seedDecisions[r.id].ts).sort().pop(),
          text: rejected.map(r => {
            const d = app.seedDecisions[r.id];
            return [r.service, r.bank].filter(Boolean).join(' · ') + ' — ' + r.rate + ' rejected by ' + d.by + ': ' + d.reason;
          }).join(' | '),
        };
        writeStore('kashierLeadReturnNote', notes);
      }
    });
    writeStore('kashierRateDecisions', all);
  })();

  /* Kashier MIDs are issued with the lead in CRM; applications carry the lead's MID. */
  const LEAD_MIDS = {
    'L-001': 'MID-10237-114', 'L-002': 'MID-10589-227', 'L-003': 'MID-11042-350', 'L-004': 'MID-20458-771',
    'L-005': 'MID-11298-463', 'L-006': 'MID-10874-556', 'L-007': 'MID-10651-689', 'L-008': 'MID-10412-792',
    'L-009': 'MID-33127-905', 'L-010': 'MID-11605-018',
    'L-011': 'MID-11734-128', 'L-012': 'MID-11756-243', 'L-013': 'MID-11789-357', 'L-014': 'MID-11802-461',
    'L-015': 'MID-11825-574', 'L-016': 'MID-11848-689', 'L-017': 'MID-11861-792',
    'L-018': 'MID-11902-118', 'L-019': 'MID-11915-229', 'L-020': 'MID-11928-330', 'L-021': 'MID-11941-441',
    'L-022': 'MID-11954-552', 'L-023': 'MID-11967-663', 'L-024': 'MID-11980-774', 'L-025': 'MID-11993-885',
    'L-026': 'MID-12006-996', 'L-027': 'MID-12019-007',
  };

  /* The seeded applications have no stored tracking link, so rebuild the one the lead page
     would hand out. */
  function seededURL(a) {
    const s = a.summary;
    const qs = new URLSearchParams({
      id: a.id, leadId: a.leadId, biz: a.biz, actor: a.actor, ts: a.ts,
      website: a.website || '',
      email: s.email, phone: s.phone, entity: s.entity, industry: s.industry,
      services: s.services.join(','),
      serviceConfigs: JSON.stringify(s.serviceConfigs),
      pricingRequests: JSON.stringify(a.requests),
      documents: JSON.stringify(a.documents || []),
      total: s.docsTotal, done: s.docsDone,
      needsApproval: a.requests.length,
      status: a.requests.length ? 'pending-rate-approval' : 'pending-onboarding-review',
    });
    if (s.posTerminals) qs.set('posTerminals', s.posTerminals);
    return 'merchant-onboarding.html?' + qs.toString();
  }

  /* The seeded applications were submitted with a bank account as their primary payout method. */
  function seededPayout(a) {
    const n = String(a.id).replace(/\D/g, '').padStart(8, '0');
    return { method: 'bank', bankName: 'National Bank of Egypt', branch: 'Main Branch', holder: String(a.biz).replace(/[^\p{L}\p{M}\p{N} ]/gu, '').replace(/ +/g, ' ').trim(), account: '1002' + n };
  }
  /* One line for a payout method, with the account or wallet number masked to its last four digits. */
  function payoutLabel(p) {
    if (!p || !p.method) return '';
    const tail = v => '\u2022\u2022\u2022\u2022 ' + String(v || '').slice(-4);
    return p.method === 'wallet' ? 'E-wallet \u2014 ' + p.provider + ' \u00b7 ' + tail(p.number)
      : 'Bank account \u2014 ' + p.bankName + ' \u00b7 ' + tail(p.account);
  }

  /* Rebuild an application from its tracking link. */
  function parseApplication(leadId, url) {
    const qs = new URLSearchParams(String(url).split('?')[1] || '');
    let requests = [];
    try { requests = JSON.parse(qs.get('pricingRequests') || '[]'); } catch (e) { requests = []; }
    let serviceConfigs = [];
    try { serviceConfigs = JSON.parse(qs.get('serviceConfigs') || '[]'); } catch (e) { serviceConfigs = []; }
    let documents = [];
    try { documents = JSON.parse(qs.get('documents') || '[]'); } catch (e) { documents = []; }
    let contracts = [];
    try { contracts = JSON.parse(qs.get('contracts') || '[]'); } catch (e) { contracts = []; }
    let payout = null;
    try { payout = JSON.parse(qs.get('payout') || 'null'); } catch (e) { payout = null; }
    return {
      id: qs.get('id') || '—', leadId: leadId || qs.get('leadId') || '', url: url,
      documents: documents,
      contracts: contracts,
      payout: payout,
      mid: qs.get('mid') || '',
      website: qs.get('website') || '',
      altIndustries: (() => { try { return JSON.parse(qs.get('altIndustries') || '[]'); } catch (e) { return []; } })(),
      transfers: (() => { try { return JSON.parse(qs.get('transfers') || 'null'); } catch (e) { return null; } })(),
      biz: qs.get('biz') || 'Untitled Application',
      actor: qs.get('actor') || 'Unknown',
      ts: qs.get('ts') || new Date().toISOString(),
      revisionOf: qs.get('revisionOf') || '',
      requests: requests,
      summary: {
        email: qs.get('email') || '', phone: qs.get('phone') || '',
        entity: qs.get('entity') || '', industry: qs.get('industry') || '',
        services: (qs.get('services') || '').split(',').filter(Boolean),
        serviceConfigs: serviceConfigs,
        posTerminals: qs.get('posTerminals') || '',
        docsDone: qs.get('done') || '0', docsTotal: qs.get('total') || '0',
      },
    };
  }

  /* Current applications, plus — flagged superseded — the earlier versions that were
     rejected and replaced by a resubmission, kept so their decisions stay on record. */
  function loadApplications() {
    const apps = [];
    const stored = readStore('kashierLeadApplications');
    const seenLeads = new Set();
    Object.entries(stored).forEach(([leadId, url]) => {
      // A stored application replaces any seeded one for the lead, even when it carries no
      // rate requests (a resubmission priced entirely at published rates, say).
      seenLeads.add(leadId);
      // Kept even with no rate requests: it is still a merchant account for the Onboarding team.
      apps.push(parseApplication(leadId, url));
    });
    SEEDED.forEach(a => {
      if (seenLeads.has(a.leadId)) return;
      apps.push(Object.assign({}, a, { url: seededURL(a), payout: a.payout || seededPayout(a) }));
    });
    const superseded = readStore('kashierSupersededApplications');
    Object.keys(superseded).forEach(appId => {
      const entry = superseded[appId];
      const app = parseApplication(entry.leadId, entry.url);
      app.superseded = true;
      app.supersededBy = entry.by;
      apps.push(app);
    });
    return apps;
  }

  /* One approval request per application per level, with its lines and where it stands. */
  function buildRequest(app, tier, allDecisions) {
    const decisions = allDecisions[app.id] || {};
    const lines = app.requests.filter(r => r.tier === tier);
    if (!lines.length) return null;
    const decided = lines.filter(r => decisions[r.id]);
    // Rates are reviewed one at a time: the request stays pending until every rate in it has
    // been reviewed, then it is rejected if any of its rates were, otherwise approved.
    const rejectedHere = lines.filter(r => decisions[r.id] && decisions[r.id].decision === 'rejected');
    let state = 'pending';
    if (decided.length === lines.length) {
      state = rejectedHere.length ? 'rejected' : 'approved';
    }
    const services = [];
    lines.forEach(r => { if (services.indexOf(r.service) === -1) services.push(r.service); });
    return {
      key: app.id + '::' + tier,
      app: app, tier: tier, lines: lines, services: services, state: state,
      pendingLines: lines.filter(r => !decisions[r.id]),
      decision: state === 'rejected' ? decisions[rejectedHere[0].id]
        : state === 'approved'
          ? decided.map(r => decisions[r.id]).sort((a, b) => new Date(b.ts) - new Date(a.ts))[0]
          : null,
    };
  }
  function approvalRequests() {
    const all = readStore('kashierRateDecisions');
    const out = [];
    loadApplications().forEach(app => ['head', 'manager'].forEach(tier => {
      const r = buildRequest(app, tier, all);
      // Closed requests leave the queue entirely — pending and decided views alike. A
      // superseded application only contributes what was actually decided on it.
      if (!r) return;
      if (app.superseded && r.state === 'pending') return;
      out.push(r);
    }));
    return out.sort((a, b) => new Date(a.app.ts) - new Date(b.app.ts));
  }
  function findApprovalRequest(appId, tier) {
    const app = loadApplications().filter(a => a.id === appId)[0];
    return app ? buildRequest(app, tier, readStore('kashierRateDecisions')) : null;
  }
  /* ── Resubmission ──────────────────────────────────────────────────────────────
     After a rejection the salesperson revises the rates that came back and resubmits.
     Rates an approver already approved keep that approval and are not sent again. */

  /* The Manager rate for a line: stored by the onboarding page, or read off the band the
     line was requested in (a Manager-band line starts at it, a Head-band line ends at it). */
  function managerRateFor(line) {
    if (line.managerRate != null) return Number(line.managerRate);
    return Number(line.tier === 'manager' ? line.from : line.to);
  }
  /* Which approval a rate + fixed fee needs — the same rule the onboarding page applies:
     under the Manager rate is the Head's call, anything else under published is a Manager's. */
  function tierForPricing(line, rate, fee) {
    const r = Number(rate), f = Number(fee);
    if (rate === '' || fee === '' || !isFinite(r) || !isFinite(f) || r <= 0 || f < 0) return '';
    if (r < managerRateFor(line)) return 'head';
    const feeStandard = line.standardFee != null ? Number(line.standardFee) : 0;
    if (r < Number(line.standard) || f < feeStandard) return 'manager';
    return 'auto';
  }

  function rejectionOf(app) {
    return statusFor(app.requests, decisionsFor(app.id)) === 'returned-to-sales';
  }
  /* The application a lead's revision starts from, if it came back rejected. */
  function rejectedApplicationFor(leadId) {
    return loadApplications().filter(a => a.leadId === leadId && !a.superseded && rejectionOf(a))[0] || null;
  }
  /* Split a returned application's lines into the rejected rates the salesperson must modify
     and the approved rates that keep their approval. */
  function revisionPlan(app) {
    const decisions = decisionsFor(app.id);
    const revise = [], approved = [];
    app.requests.forEach(line => {
      const d = decisions[line.id];
      if (d && d.decision === 'approved') approved.push({ line: line, decision: d });
      else revise.push({ line: line, decision: d || null });
    });
    return { revise: revise, approved: approved };
  }

  /* Create the resubmitted application: a new id carrying the revised rates that still need
     approval, linked back to the one it replaces. The lead moves to Waiting Rate Approval, or
     straight to Underwriting Review when every revised rate is at published pricing. */
  function resubmitApplication(opts) {
    const app = opts.app;
    // Check the stored record, not the caller's copy — it may predate a resubmission made
    // in another tab or a moment ago.
    if (readStore('kashierSupersededApplications')[app.id] || !rejectionOf(app)) return null;
    const revised = opts.revised; // [{ line, rate, fee, note }]
    const qs = new URLSearchParams(String(app.url).split('?')[1] || '');
    const newId = 'APP-' + String(Date.now()).slice(-8);
    const ts = new Date().toISOString();

    const pending = [];
    revised.forEach(item => {
      const tier = tierForPricing(item.line, item.rate, item.fee);
      if (!tier || tier === 'auto') return;
      const managerRate = managerRateFor(item.line);
      pending.push(Object.assign({}, item.line, {
        tier: tier,
        requested: Number(item.rate),
        requestedFee: Number(item.fee),
        note: String(item.note || '').trim(),
        managerRate: managerRate,
        from: tier === 'manager' ? managerRate : (item.line.tier === 'head' ? item.line.from : 0),
        to: tier === 'manager' ? item.line.standard : managerRate,
      }));
    });

    const status = pending.length ? 'pending-rate-approval' : 'pending-onboarding-review';
    qs.set('id', newId);
    qs.set('ts', ts);
    qs.set('pricingRequests', JSON.stringify(pending));
    qs.set('needsApproval', String(pending.length));
    qs.set('status', status);
    qs.set('revisionOf', app.id);
    qs.set('revision', String(Number(qs.get('revision') || 1) + 1));
    if (app.leadId) qs.set('leadId', app.leadId);
    const url = 'merchant-onboarding.html?' + qs.toString();

    const statuses = readStore('kashierAppStatus');
    statuses[newId] = status;
    writeStore('kashierAppStatus', statuses);

    // Keep the rejected version on record so its decisions stay visible to approvers.
    const superseded = readStore('kashierSupersededApplications');
    superseded[app.id] = { leadId: app.leadId, url: app.url, by: newId, ts: ts };
    writeStore('kashierSupersededApplications', superseded);

    if (app.leadId) {
      const apps = readStore('kashierLeadApplications');
      apps[app.leadId] = url;
      writeStore('kashierLeadApplications', apps);

      const leadStatuses = readStore('kashierLeadStatusOverrides');
      leadStatuses[app.leadId] = LEAD_STATUS[status];
      writeStore('kashierLeadStatusOverrides', leadStatuses);

      const ra = readStore('kashierLeadRateApproval');
      ra[app.leadId] = pending.length > 0;
      writeStore('kashierLeadRateApproval', ra);

      // The rejection has been answered, so its note gives way to a resubmission entry.
      const notes = readStore('kashierLeadReturnNote');
      delete notes[app.leadId];
      writeStore('kashierLeadReturnNote', notes);

      const resub = readStore('kashierLeadResubmitted');
      resub[app.leadId] = {
        ts: ts, appId: newId, previousId: app.id, pending: pending.length,
        head: pending.filter(p => p.tier === 'head').length,
        manager: pending.filter(p => p.tier === 'manager').length,
        by: ROLES.sales.name,
      };
      writeStore('kashierLeadResubmitted', resub);
    }
    return { id: newId, url: url, status: status, pending: pending };
  }

  /* ── Merchant accounts (Onboarding team) ─────────────────────────────────────────
     A submitted application is a merchant account in the Merchant module. Once any rate
     approvals are through, the Onboarding team works it in two stages:
       Application submitted  →  ✓ approve internally, send to the bank (or ✗ reject)
       Pending Configurations →  Go Live, once the bank/vendor approval and credentials arrive
     Each step moves the lead and the salesperson's tracking page along with it. */
  const ACCOUNT_STATUS = {
    'rate-approval':          { label: 'Waiting rate approval',   tone: 'warn' },
    'returned':               { label: 'Returned to sales',       tone: 'danger' },
    'submitted':              { label: 'Application submitted',   tone: 'warn' },
    'pending-configurations': { label: 'Pending Configurations',  tone: 'warn' },
    'rejected':               { label: 'Application rejected',    tone: 'danger' },
    'live':                   { label: 'Live',                    tone: 'success' },
  };

  function midFor(app) { return app.mid || LEAD_MIDS[app.leadId] || ''; }

  /* The stored onboarding step, or where rate approval leaves the account before one exists. */
  function accountRecord(app) {
    const stored = readStore('kashierAccountStatus')[app.id];
    if (stored) return stored;
    if (app.seedAccount) return app.seedAccount;
    const decisions = decisionsFor(app.id);
    if (app.requests.some(r => !decisions[r.id])) return { status: 'rate-approval' };
    if (app.requests.some(r => decisions[r.id] && decisions[r.id].decision === 'rejected')) return { status: 'returned' };
    return { status: 'submitted' };
  }
  function accountStatusFor(app) { return accountRecord(app).status; }

  function merchantAccounts() {
    return loadApplications()
      .filter(a => !a.superseded)
      .map(a => {
        const rec = accountRecord(a);
        return { app: a, mid: midFor(a), status: rec.status, meta: ACCOUNT_STATUS[rec.status], record: rec };
      })
      .sort((x, y) => new Date(y.app.ts) - new Date(x.app.ts));
  }
  function findAccount(appId) {
    return merchantAccounts().filter(a => a.app.id === appId)[0] || null;
  }

  function setAccount(app, record, appStatus, leadStatus) {
    const all = readStore('kashierAccountStatus');
    all[app.id] = record;
    writeStore('kashierAccountStatus', all);
    const statuses = readStore('kashierAppStatus');
    statuses[app.id] = appStatus;
    writeStore('kashierAppStatus', statuses);
    if (app.leadId) {
      const leads = readStore('kashierLeadStatusOverrides');
      leads[app.leadId] = leadStatus;
      writeStore('kashierLeadStatusOverrides', leads);
    }
  }

  /* Stage 1 ✓ — approved internally, on its way to the bank. */
  function approveAccount(opts) {
    const app = opts.app, prev = accountRecord(app);
    if (opts.role !== 'onboarding' || prev.status !== 'submitted') return null;
    const ts = new Date().toISOString();
    setAccount(app, { status: 'pending-configurations', by: ROLES.onboarding.name, ts: ts, approvedTs: ts },
      'pending-bank-submission', 'bank-submission');
    return 'pending-configurations';
  }
  /* Stage 1 ✗ — the application goes back to the salesperson with the reason. */
  function rejectAccount(opts) {
    const app = opts.app, prev = accountRecord(app);
    if (opts.role !== 'onboarding' || prev.status !== 'submitted' || !String(opts.reason || '').trim()) return null;
    const ts = new Date().toISOString();
    setAccount(app, { status: 'rejected', by: ROLES.onboarding.name, ts: ts, reason: opts.reason.trim() },
      'rejected-by-onboarding', 'application');
    if (app.leadId) {
      const notes = readStore('kashierLeadReturnNote');
      notes[app.leadId] = { ts: ts, kind: 'onboarding',
        text: 'Application rejected by the Onboarding team (' + ROLES.onboarding.name + '): ' + opts.reason.trim() };
      writeStore('kashierLeadReturnNote', notes);
    }
    return 'rejected';
  }
  /* Stage 2 — bank/vendor approval and credentials are in; the account goes live. */
  function goLiveAccount(opts) {
    const app = opts.app, prev = accountRecord(app);
    if (opts.role !== 'onboarding' || prev.status !== 'pending-configurations') return null;
    setAccount(app, { status: 'live', by: ROLES.onboarding.name, ts: new Date().toISOString(), approvedTs: prev.approvedTs || prev.ts },
      'live', 'activated');
    return 'live';
  }

  /* ── Payout method changes ───────────────────────────────────────────────────────
     A change request moves the account from one payout method to another and is decided by the
     Onboarding team. The activity keeps every request — who raised it, what changed, who decided it,
     when, and the reason when it was rejected. The payout in force is the submitted one with every
     approved request applied in order. The demo accounts carry a short seeded history. */
  const PAYOUT_FIELDS = {
    bank:   [['bankName', 'Bank Name'], ['branch', 'Bank Branch Name'], ['holder', 'Account Holder Name'], ['account', 'Account Number']],
    wallet: [['provider', 'Wallet Provider'], ['number', 'Wallet Mobile Number'], ['holder', 'Wallet Holder Name']],
  };
  const PAYOUT_METHOD_LABEL = { bank: 'Bank Account', wallet: 'E-Wallet' };

  const SECONDARY_SEED = { method: 'wallet', provider: 'Vodafone Cash', number: '01012345678', holder: 'Hassan Ibrahim' };

  function seededPayoutChanges(app) {
    const status = accountStatusFor(app);
    if (status !== 'pending-configurations' && status !== 'live') return [];
    const base = app.payout;
    if (!base || base.method !== 'bank') return [];
    const t0 = new Date(app.ts).getTime(), now = Date.now(), DAY = 86400000;
    const at = days => new Date(Math.min(t0 + days * DAY + 36e5 * 3, now)).toISOString();
    const n = String(app.id).replace(/\D/g, '').padStart(8, '0');
    const afterBranch = Object.assign({}, base, { branch: 'Maadi' });
    const sec = SECONDARY_SEED;
    const by = ROLES.onboarding.name;
    // A request lists the accounts it changes; each account is decided on its own.
    const reqs = [
      { id: app.id + '::pc1', ref: 'PCR-' + n + '-01', ts: at(3), by: app.biz, items: [
        { account: 'Primary account', from: base, to: afterBranch, decision: 'approved', decidedBy: by, decidedTs: at(4) }] },
      { id: app.id + '::pc2', ref: 'PCR-' + n + '-02', ts: at(8), by: app.biz, items: [
        { account: 'Primary account', from: afterBranch,
          to: { method: 'wallet', provider: 'Vodafone Cash', number: '01012345678', holder: 'Hassan Ibrahim' },
          decision: 'rejected', decidedBy: by, decidedTs: at(9),
          reason: 'The wallet holder name does not match the registered business owner. Resubmit with the owner’s name or keep the bank account.' }] },
    ];
    // Newer requests from the merchant, still waiting on the Onboarding team.
    reqs.push({ id: app.id + '::pc4', ref: 'PCR-' + n + '-04', ts: at(16), by: app.biz, items: [
      { account: 'Primary account', from: afterBranch, to: Object.assign({}, afterBranch, { holder: afterBranch.holder + ' Trading', account: '3004' + n }) }] });
    if (status === 'live') {
      reqs.push({ id: app.id + '::pc5', ref: 'PCR-' + n + '-05', ts: at(18), by: app.biz, items: [
        { account: 'Secondary account', from: sec,
          to: { method: 'bank', bankName: 'Commercial International Bank (CIB)', branch: 'Nasr City', holder: sec.holder, account: '4005' + n } }] });
      reqs.push({ id: app.id + '::pc3', ref: 'PCR-' + n + '-03', ts: at(14), by: app.biz, items: [
        { account: 'Primary account', from: afterBranch, to: Object.assign({}, afterBranch, { bankName: 'Banque Misr', branch: 'Heliopolis', account: '2003' + n }) },
        { account: 'Secondary account', from: sec, to: Object.assign({}, sec, { provider: 'Orange Cash', number: '01211122233' }) },
      ] });
    }
    return reqs;
  }

  /* Every payout change request on the account, newest first, with each account's decision applied.
     A request is pending while any of its accounts awaits a decision; once all are decided it is
     approved, rejected, or partial when the accounts went different ways. */
  function payoutChanges(app) {
    const decided = readStore('kashierPayoutDecisions')[app.id] || {};
    return seededPayoutChanges(app).map(r => {
      const items = r.items.map((it, i) => {
        const out = Object.assign({}, it, { id: r.id + '::' + i });
        const d = decided[out.id];
        if (d) { out.decision = d.decision; out.decidedBy = d.by; out.decidedTs = d.ts; out.reason = d.reason || ''; }
        out.state = out.decision || 'pending';
        return out;
      });
      const nOk = items.filter(i => i.state === 'approved').length, nNo = items.filter(i => i.state === 'rejected').length;
      const state = nOk + nNo < items.length ? 'pending' : !nNo ? 'approved' : !nOk ? 'rejected' : 'partial';
      const stamps = items.map(i => i.decidedTs).filter(Boolean).sort();
      return Object.assign({}, r, { items: items, state: state, decidedTs: stamps[stamps.length - 1] || '',
        decidedBy: (items.filter(i => i.decidedTs).sort((a, b) => new Date(b.decidedTs) - new Date(a.decidedTs))[0] || {}).decidedBy });
    }).sort((a, b) => new Date(b.ts) - new Date(a.ts));
  }

  /* The primary payout in force: the submitted one with each approved change applied, oldest first. */
  function currentPayout(app) {
    const approved = [];
    payoutChanges(app).forEach(r => r.items.forEach(i => { if (i.state === 'approved' && i.account === 'Primary account') approved.push(i); }));
    approved.sort((a, b) => new Date(a.decidedTs) - new Date(b.decidedTs));
    return approved.length ? approved[approved.length - 1].to : app.payout;
  }

  /* The payout accounts in force now, each with when and by which request it last changed. */
  function payoutAccounts(app) {
    const changes = payoutChanges(app).slice().reverse();   // oldest first
    const latest = name => {
      let hit = null;
      changes.forEach(r => r.items.forEach(i => {
        if (i.account === name && i.state === 'approved' && (!hit || new Date(i.decidedTs) >= new Date(hit.item.decidedTs))) hit = { item: i, ref: r.ref };
      }));
      return hit;
    };
    const accounts = [];
    if (app.payout && app.payout.method) {
      const hit = latest('Primary account');
      accounts.push({ account: 'Primary account', details: hit ? hit.item.to : app.payout,
        updatedTs: hit ? hit.item.decidedTs : '', ref: hit ? hit.ref : '' });
    }
    if (accountStatusFor(app) === 'live') {
      const hit = latest('Secondary account');
      accounts.push({ account: 'Secondary account', details: hit ? hit.item.to : SECONDARY_SEED,
        updatedTs: hit ? hit.item.decidedTs : '', ref: hit ? hit.ref : '' });
    }
    return accounts;
  }

  /* Field-by-field difference between two payout methods; only what changed. */
  function payoutDiff(from, to) {
    const rows = [];
    if (!from || from.method !== to.method) rows.push({ label: 'Method', from: from ? PAYOUT_METHOD_LABEL[from.method] : '', to: PAYOUT_METHOD_LABEL[to.method] });
    PAYOUT_FIELDS[to.method].forEach(([k, label]) => {
      const was = from && from.method === to.method ? from[k] : '';
      if (was !== to[k]) rows.push({ label: label, from: was || '', to: to[k] });
    });
    return rows;
  }

  /* Decide one account of a request, by its item id. */
  function decidePayoutChange(opts) {
    let item = null;
    payoutChanges(opts.app).forEach(r => r.items.forEach(i => { if (i.id === opts.id) item = i; }));
    const reason = String(opts.reason || '').trim();
    if (opts.role !== 'onboarding' || !item || item.state !== 'pending') return null;
    if (opts.decision === 'rejected' && !reason) return null;
    const all = readStore('kashierPayoutDecisions');
    (all[opts.app.id] = all[opts.app.id] || {})[item.id] = {
      decision: opts.decision, by: ROLES.onboarding.name, ts: new Date().toISOString(), reason: opts.decision === 'rejected' ? reason : '' };
    writeStore('kashierPayoutDecisions', all);
    return opts.decision;
  }

  /* What happened to the account, oldest first — the Logs tab. */
  function accountLog(app) {
    const events = [{ ts: app.ts, who: app.actor, text: 'Application submitted by Sales' }];
    const decisions = decisionsFor(app.id);
    const seen = {};
    app.requests.forEach(r => {
      const d = decisions[r.id];
      if (!d) return;
      const key = d.ts + d.by + d.decision;
      if (seen[key]) { seen[key].rates.push(r.rate); return; }
      seen[key] = { ts: d.ts, who: d.by, decision: d.decision, reason: d.reason, rates: [r.rate] };
      events.push(seen[key]);
    });
    Object.keys(seen).forEach(k => {
      const e = seen[k];
      e.text = (e.decision === 'approved' ? 'Approved ' : 'Rejected ') + e.rates.join(', ') + (e.reason ? ' — ' + e.reason : '');
    });
    const rec = accountRecord(app);
    if (rec.approvedTs) events.push({ ts: rec.approvedTs, who: rec.by, text: 'Approved internally and sent to the bank' });
    if (rec.status === 'rejected') events.push({ ts: rec.ts, who: rec.by, text: 'Application rejected — ' + rec.reason });
    if (rec.status === 'live') events.push({ ts: rec.ts, who: rec.by, text: 'Bank/vendor approval received — account is live' });
    return events.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  }

  function accountURL(appId) {
    return 'merchant-account.html?app=' + encodeURIComponent(appId);
  }

  /* An application has one view, whatever its status: the onboarding form. */
  function applicationURL(leadId) {
    return leadId ? 'merchant-onboarding.html?leadId=' + encodeURIComponent(leadId) : 'sales-leads.html';
  }

  /* ── Activity log ───────────────────────────────────────────────────────────────
     Every action on an application, newest first. Most of it is read off what was already
     recorded (submission, each rate decision, the Onboarding team's steps, resubmissions);
     the rest — starting the application, marking it Lost — is written as it happens. */
  function logEvent(leadId, who, text, ts, extra) {
    if (!leadId) return;
    const all = readStore('kashierApplicationLog');
    (all[leadId] = all[leadId] || []).push(Object.assign({ ts: ts || new Date().toISOString(), who: who, text: text }, extra || {}));
    writeStore('kashierApplicationLog', all);
  }
  const money = (pct, fee, cur) => [pct != null ? pct + '%' : '', fee != null ? fee + ' ' + (cur || 'EGP') : ''].filter(Boolean).join(' + ') || '\u2014';
  /* Structured events, newest first: { ts, who, role, system, action, category, text, details:[{label, value | from, to}] }. */
  function applicationLog(leadId) {
    const apps = loadApplications().filter(a => a.leadId === leadId);
    const superseded = readStore('kashierSupersededApplications');
    const replaces = {};   // new application id -> the rejected one it replaced
    Object.keys(superseded).forEach(prev => { replaces[superseded[prev].by] = prev; });
    const events = [];
    apps.forEach(app => {
      const sm = app.summary || {};
      const need = app.requests || [];
      const nMgr = need.filter(r => r.tier === 'manager').length, nHead = need.filter(r => r.tier === 'head').length;
      const alt = (app.altIndustries || []).map(x => x.activity || x.industry).join(', ');
      const details = [{ label: 'Application', value: app.id }];
      if (replaces[app.id]) details.push({ label: 'Replaces', value: replaces[app.id] });
      details.push({ label: 'Services', value: (sm.services || []).join(', ') || '\u2014' });
      if (sm.industry) details.push({ label: 'Industry', value: sm.industry + (alt ? ' \u2014 activities: ' + alt : '') });
      details.push({ label: 'Rates needing approval', value: need.length
        ? need.length + ' \u2014 ' + [nMgr ? nMgr + ' Sales Manager' : '', nHead ? nHead + ' Head of Sales' : ''].filter(Boolean).join(' \u00b7 ')
        : 'None \u2014 every rate at published pricing' });
      const docs = (app.documents || []).length || Number(sm.docsDone || 0);
      if (docs) details.push({ label: 'Documents', value: docs + ' uploaded' });
      if (app.payout && app.payout.method) details.push({ label: 'Payout method', value: payoutLabel(app.payout) });
      events.push({ ts: app.ts, who: app.actor, role: 'Salesperson', action: replaces[app.id] ? 'Resubmitted' : 'Submitted', category: 'Application',
        text: replaces[app.id] ? 'Resubmitted with revised rates' : 'Application submitted', details: details });

      const d = decisionsFor(app.id);
      // Approvals carried over from the version this one replaces are already in the log once.
      const prevD = replaces[app.id] ? decisionsFor(replaces[app.id]) : {};
      need.forEach(r => {
        const dec = d[r.id];
        if (!dec) return;
        if (prevD[r.id] && prevD[r.id].ts === dec.ts) return;
        const det = [
          { label: 'Service', value: [r.service, r.bank].filter(Boolean).join(' \u00b7 ') },
          { label: 'Requested', value: money(r.requested, r.requestedFee, r.feeCurrency) },
          { label: 'Published', value: money(r.standard, r.standardFee, r.feeCurrency) },
        ];
        if (r.note) det.push({ label: 'Salesperson justification', value: r.note });
        if (dec.reason) det.push({ label: 'Decision comment', value: dec.reason });
        events.push({ ts: dec.ts, who: dec.by, role: dec.roleLabel, action: dec.decision === 'approved' ? 'Approved' : 'Rejected',
          category: 'Rates', text: r.rate, details: det });
      });
      if (need.length && need.every(r => d[r.id])) {
        const last = need.map(r => d[r.id].ts).sort().pop();
        const rejected = need.filter(r => d[r.id].decision === 'rejected').length;
        events.push({ ts: last, who: 'Workflow Engine', role: 'System', system: true, action: rejected ? 'Returned' : 'Advanced', category: 'Application',
          text: rejected ? 'Returned to the salesperson' : 'Every rate approved \u2014 sent to Underwriting Review',
          details: rejected ? [{ label: 'Rejected rates', value: rejected + ' of ' + need.length }, { label: 'Next step', value: app.actor + ' modifies the rejected rates and resubmits' }]
            : [{ label: 'Approved rates', value: String(need.length) }, { label: 'Next step', value: 'Underwriting Review by the Onboarding team' }] });
      }
      const rec = accountRecord(app);
      if (rec.approvedTs) events.push({ ts: rec.approvedTs, who: rec.by, role: 'Onboarding Team', action: 'Approved', category: 'Underwriting',
        text: 'Approved internally and sent to the bank', details: [{ label: 'Application', value: app.id }] });
      if (rec.status === 'rejected') events.push({ ts: rec.ts, who: rec.by, role: 'Onboarding Team', action: 'Rejected', category: 'Underwriting',
        text: 'Application rejected by the Onboarding team', details: [{ label: 'Application', value: app.id }, { label: 'Reason', value: rec.reason || '\u2014' }] });
      if (rec.status === 'live') events.push({ ts: rec.ts, who: rec.by, role: 'Onboarding Team', action: 'Live', category: 'Underwriting',
        text: 'Bank/vendor approval received \u2014 account is live', details: [{ label: 'Application', value: app.id }] });
    });
    (readStore('kashierApplicationLog')[leadId] || []).forEach(e => events.push(Object.assign({ action: 'Note', category: 'Application', role: '' }, e)));
    return events.sort((x, y) => new Date(y.ts) - new Date(x.ts));
  }

  /* Rate requests are reviewed on the application's own view too. */
  function requestURL(appId, tier) {
    const a = loadApplications().filter(x => x.id === appId)[0];
    return applicationURL(a && a.leadId);
  }

  return {
    ROLES: ROLES, TIER_LABEL: TIER_LABEL, TIER_OWNER: TIER_OWNER,
    readStore: readStore, writeStore: writeStore,
    getRole: getRole, setRole: setRole,
    decisionsFor: decisionsFor, canRoleAct: canRoleAct,
    statusFor: statusFor, recordDecision: recordDecision, recordRequestDecision: recordRequestDecision,
    loadApplications: loadApplications,
    approvalRequests: approvalRequests, findApprovalRequest: findApprovalRequest, requestURL: requestURL,
    tierForPricing: tierForPricing, rejectedApplicationFor: rejectedApplicationFor,
    revisionPlan: revisionPlan, resubmitApplication: resubmitApplication, applicationURL: applicationURL, logEvent: logEvent, applicationLog: applicationLog, payoutLabel: payoutLabel,
    ACCOUNT_STATUS: ACCOUNT_STATUS, midFor: midFor, accountStatusFor: accountStatusFor,
    merchantAccounts: merchantAccounts, findAccount: findAccount, accountLog: accountLog, accountURL: accountURL,
    approveAccount: approveAccount, rejectAccount: rejectAccount, goLiveAccount: goLiveAccount,
    payoutChanges: payoutChanges, payoutAccounts: payoutAccounts, currentPayout: currentPayout, payoutDiff: payoutDiff, decidePayoutChange: decidePayoutChange,
  };
})();
