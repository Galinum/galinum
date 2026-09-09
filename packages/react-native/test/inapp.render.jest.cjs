const React = require('react');
const { act, create } = require('react-test-renderer');
const { View, Modal, Image, Pressable, AppState } = require('react-native');
const { InAppMessages, InAppLifecycle } = require('../src/inapp.tsx');
const { inAppFixture, inAppMessage } = require('./inapp-fixture.ts');
global.IS_REACT_ACT_ENVIRONMENT = true;
let f;
let root;
const tick = async fn => { await act(async () => { await fn?.(); }); };
const messages = () => root.root.findAllByProps({ testID: 'galinum-message' }).filter(node => node.type === View);
const mount = async element => { await tick(() => { root = create(element); }); };
const enter = async (items, element) => {
  await mount(element ?? React.createElement(InAppMessages, { controller: f.controller }));
  await tick(() => { f.enter(); f.respond(items); });
};
const layout = async () => { await tick(() => messages()[0].props.onLayout()); };
const button = label => root.root.findAll(node => typeof node.props.onPress === 'function' && node.props.accessibilityRole === 'button').find(node => node.props.accessibilityLabel === label || node.findAllByType(require('react-native').Text).some(text => text.props.children === label));
beforeEach(() => {
  f = inAppFixture();
  jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() });
});
afterEach(async () => { if (root) await tick(() => root.unmount()); root = undefined; f.controller.dispose(); jest.useRealTimers(); jest.restoreAllMocks(); });

test('native layout commits one message across hosts and remounts', async () => {
  const hosts = React.createElement(React.Fragment, null, React.createElement(InAppMessages, { controller: f.controller }), React.createElement(InAppMessages, { controller: f.controller }));
  await enter([inAppMessage('one'), inAppMessage('two')], hosts);
  expect(messages()).toHaveLength(1);
  expect(f.admissions).toHaveLength(0);
  await layout();
  expect(f.admissions.map(x => x.type)).toEqual(['shown']);
  await tick(() => { root.update(null); });
  await tick(() => { root.update(hosts); });
  expect(messages()).toHaveLength(0);
  expect(f.requests).toHaveLength(1);
  expect(f.admissions).toHaveLength(1);
});

test('a null custom renderer skips without an impression or a consumed slot', async () => {
  await enter([inAppMessage('null'), inAppMessage('visible')], React.createElement(InAppMessages, { controller: f.controller, render: message => message.deliveryId === 'null' ? null : React.createElement(View, { testID: 'custom-content' }) }));
  expect(f.admissions).toHaveLength(0);
  await tick(() => root.root.findAllByProps({ testID: 'galinum-custom' })[0].props.onLayout());
  expect(f.admissions.map(x => [x.deliveryId, x.type])).toEqual([['visible', 'shown']]);
});

test('modal exposure waits for native onShow; image failure preserves actions', async () => {
  const message = inAppMessage('modal', 'modal');
  message.content.media = { url: 'https://example.com/update.gif', alt: 'New report preview' };
  await enter([message]);
  expect(f.admissions).toHaveLength(0);
  expect(root.root.findByType(Image).props.source.uri).toMatch(/gif$/);
  await tick(() => root.root.findByType(Image).props.onError());
  expect(root.root.findAllByType(Image)).toHaveLength(0);
  expect(button('Dismiss message')).toBeDefined();
  await tick(() => root.root.findByType(Modal).props.onShow());
  expect(f.admissions.map(x => x.type)).toEqual(['shown']);
  await tick(() => root.root.findByType(Modal).props.onRequestClose());
  expect(f.admissions.map(x => x.type)).toEqual(['shown', 'dismissed']);
});

test('app confirmation and navigation readiness gate fresh requests', async () => {
  f.session({ appConfirmed: false });
  await mount(React.createElement(InAppMessages, { controller: f.controller }));
  await tick(() => { f.enter(); });
  expect(f.requests).toHaveLength(0);
  await tick(() => { f.controller.navigate('home', '/', false); f.session({ appConfirmed: true }); });
  expect(f.requests).toHaveLength(0);
  await tick(() => { f.controller.navigate('home', '/', true); f.respond([inAppMessage('ready')]); });
  expect(messages()).toHaveLength(1);
});

test.each([{ userId: 'B' }, { facts: 1 }, { owner: 'new-owner' }, { appConfirmed: false }])('stale decision cannot paint after session change %j', async change => {
  await mount(React.createElement(InAppMessages, { controller: f.controller }));
  await tick(() => { f.enter(); f.session(change); f.respond([inAppMessage('stale')], 0); });
  expect(messages()).toHaveLength(0);
  expect(f.admissions).toHaveLength(0);
});

test('deadline settles empty even when transport ignores abort; next entry can retry', async () => {
  jest.useFakeTimers();
  await mount(React.createElement(InAppMessages, { controller: f.controller }));
  await tick(() => f.enter());
  await tick(() => jest.advanceTimersByTime(51));
  await tick(() => f.respond([inAppMessage('late')], 0));
  expect(messages()).toHaveLength(0);
  await tick(() => { f.enter('next'); f.respond([inAppMessage('fresh')]); });
  expect(messages()).toHaveLength(1);
});

test('failed and mismatched decisions settle empty', async () => {
  await mount(React.createElement(InAppMessages, { controller: f.controller }));
  await tick(() => { f.enter(); f.requests[0].reject(new Error('offline')); });
  expect(f.controller.getSnapshot().phase).toBe('empty');
  await tick(() => { f.enter('second'); f.respond([inAppMessage('wrong')], 1, { requestId: 'old' }); });
  expect(messages()).toHaveLength(0);
  expect(f.controller.getSnapshot().phase).toBe('empty');
});

test('shown admission failure retains UI; terminal retry preserves exact IDs and order', async () => {
  f.fail('shown');
  await enter([inAppMessage('retry')]);
  await layout();
  expect(messages()).toHaveLength(1);
  expect(button('Try again')).toBeDefined();
  await tick(() => button('Dismiss message').props.onPress());
  expect(f.admissions.every(x => x.type === 'shown')).toBe(true);
  f.fail('dismissed');
  await tick(() => button('Try again').props.onPress());
  expect(messages()).toHaveLength(1);
  f.fail();
  await tick(() => button('Try again').props.onPress());
  expect(messages()).toHaveLength(0);
  const shown = f.admissions.filter(x => x.type === 'shown');
  const terminal = f.admissions.filter(x => x.type === 'dismissed');
  expect(new Set(shown.map(x => x.feedbackId)).size).toBe(1);
  expect(new Set(terminal.map(x => x.feedbackId)).size).toBe(1);
  expect(terminal[0].shownFeedbackId).toBe(shown[0].feedbackId);
  await tick(() => { f.enter('later'); f.respond([inAppMessage('retry')]); });
  expect(messages()).toHaveLength(0);
});

test.each(['https://example.com/report', 'galinum-proof://report'])('CTA invokes validated destination after terminal admission: %s', async url => {
  const message = inAppMessage('cta');
  message.content.cta = { label: 'Open report', destination: { kind: url.startsWith('https') ? 'website' : 'app', url } };
  await enter([message]); await layout();
  await tick(() => button('Open report').props.onPress());
  expect(f.admissions.map(x => x.type)).toEqual(['shown', 'clicked']);
  expect(f.destinations).toEqual([url]);
});

test('unsupported schemes skip without consuming; theme reaches native card', async () => {
  const unsafe = inAppMessage('unsafe');
  unsafe.content.cta = { label: 'Open', destination: { kind: 'app', url: 'other://report' } };
  await enter([unsafe, inAppMessage('safe')], React.createElement(InAppMessages, { controller: f.controller, theme: 'dark' }));
  expect(messages()[0].props.style[1].backgroundColor).toBe('#18181b');
  await layout();
  expect(f.admissions.map(x => x.deliveryId)).toEqual(['safe']);
});

test('foreground and navigation lifecycle issue fresh entries, never host remounts', async () => {
  let change;
  const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation((name, listener) => { change = listener; return { remove() {} }; });
  AppState.currentState = 'active';
  const tree = key => React.createElement(React.Fragment, null, React.createElement(InAppLifecycle, { controller: f.controller, routeKey: key, path: '/reports', navigationReady: true }), React.createElement(InAppMessages, { controller: f.controller }));
  await mount(tree('one'));
  expect(f.requests).toHaveLength(1);
  await tick(() => { change('background'); change('active'); });
  expect(f.requests).toHaveLength(2);
  await tick(() => root.update(tree('two')));
  expect(f.requests).toHaveLength(3);
  expect(new Set(f.requests.map(x => x.input.requestId)).size).toBe(3);
  spy.mockRestore();
});

test('a settled candidate loses authority at same-user fact invocation before a host commits', async () => {
  await tick(() => { f.enter(); f.respond([inAppMessage('settled')]); });
  expect(f.controller.getSnapshot().phase).toBe('ready');
  await tick(() => f.session({ facts: 1 }));
  await mount(React.createElement(InAppMessages, { controller: f.controller }));
  expect(messages()).toHaveLength(0);
  expect(f.admissions).toHaveLength(0);
  await tick(() => f.respond([inAppMessage('current')]));
  await layout();
  expect(f.admissions.map(x => x.deliveryId)).toEqual(['current']);
});

test('React commit consumes authority even if a host unmounts before native layout', async () => {
  await enter([inAppMessage('one'), inAppMessage('two')]);
  const oldLayout = messages()[0].props.onLayout;
  await tick(() => root.update(null));
  await tick(() => root.update(React.createElement(InAppMessages, { controller: f.controller })));
  await tick(oldLayout);
  expect(messages()).toHaveLength(0);
  expect(f.admissions).toHaveLength(0);
});

test('captured actions and native layout callbacks cannot follow an account switch', async () => {
  let actions;
  await enter([inAppMessage('A')], React.createElement(InAppMessages, { controller: f.controller, render: (message, value) => { actions = value; return React.createElement(View); } }));
  const onLayout = root.root.findAllByProps({ testID: 'galinum-custom' })[0].props.onLayout;
  await tick(onLayout);
  const oldActions = actions;
  await tick(() => f.session({ userId: 'B', facts: 1 }));
  await tick(async () => { onLayout(); await oldActions.dismiss(); });
  expect(f.admissions.map(x => [x.userId, x.type])).toEqual([['A', 'shown']]);
});

test('late completion reads cannot authorize a stale entry', async () => {
  let release;
  f.feedback.isCompleted = () => new Promise(resolve => { release = resolve; });
  await mount(React.createElement(InAppMessages, { controller: f.controller }));
  await tick(() => { f.enter(); f.respond([inAppMessage('old')]); });
  await tick(() => f.session({ facts: 1 }));
  await tick(() => release(false));
  expect(messages()).toHaveLength(0);
});

test('wrong admission receipt cannot release terminal feedback', async () => {
  const admit = f.feedback.admit;
  f.feedback.admit = async input => ({ ...(await admit(input)), feedbackId: 'wrong' });
  await enter([inAppMessage('receipt')]); await layout();
  await tick(() => button('Dismiss message').props.onPress());
  expect(f.admissions.every(x => x.type === 'shown')).toBe(true);
  expect(messages()).toHaveLength(1);
  f.feedback.admit = admit;
  await tick(() => button('Try again').props.onPress());
  expect(f.admissions.at(-1).type).toBe('dismissed');
});

test('lifecycle remount in the same foreground route does not create a second entry', async () => {
  AppState.currentState = 'active';
  const tree = React.createElement(React.Fragment, null, React.createElement(InAppLifecycle, { controller: f.controller, routeKey: 'home', path: '/', navigationReady: true }), React.createElement(InAppMessages, { controller: f.controller }));
  await mount(tree);
  await tick(() => f.respond([inAppMessage('one')])); await layout();
  await tick(() => root.update(null));
  await tick(() => root.update(tree));
  expect(f.requests).toHaveLength(1);
  expect(messages()).toHaveLength(0);
});


test('same-user facts do not reopen a committed entry or disable its actions', async () => {
  await enter([inAppMessage('committed')]); await layout();
  await tick(() => f.session({ facts: 1 }));
  expect(f.requests).toHaveLength(1);
  expect(messages()).toHaveLength(1);
  await tick(() => button('Dismiss message').props.onPress());
  expect(f.admissions.map(x => x.type)).toEqual(['shown', 'dismissed']);
  await tick(() => f.session({ facts: 2 }));
  expect(f.requests).toHaveLength(1);
  expect(messages()).toHaveLength(0);
});

test('actions captured by a skipped custom renderer cannot dismiss its successor', async () => {
  let skippedActions;
  await enter([inAppMessage('skip'), inAppMessage('visible')], React.createElement(InAppMessages, {
    controller: f.controller,
    render: (message, actions) => {
      if (message.deliveryId === 'skip') { skippedActions = actions; return null; }
      return React.createElement(View);
    },
  }));
  await tick(() => root.root.findAllByProps({ testID: 'galinum-custom' })[0].props.onLayout());
  await tick(() => skippedActions.dismiss());
  expect(f.admissions.map(x => x.type)).toEqual(['shown']);
});

test('StrictMode effect replay keeps the committed host visible', async () => {
  await tick(() => { f.enter(); f.respond([inAppMessage('strict')]); });
  await mount(React.createElement(React.StrictMode, null, React.createElement(InAppMessages, { controller: f.controller })));
  expect(messages()).toHaveLength(1);
  await layout();
  expect(f.admissions.map(x => x.type)).toEqual(['shown']);
});


test('background cancels selection and foreground requires a newly correlated decision', async () => {
  await enter([inAppMessage('before-background')]);
  const oldLayout = messages()[0].props.onLayout;
  await tick(() => f.controller.foreground(false));
  await tick(oldLayout);
  expect(messages()).toHaveLength(0);
  expect(f.admissions).toHaveLength(0);
  await tick(() => f.controller.foreground(true));
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1].input.entryId).not.toBe(f.requests[0].input.entryId);
  await tick(() => f.respond([inAppMessage('foreground')])); await layout();
  expect(f.admissions.map(x => x.deliveryId)).toEqual(['foreground']);
});

test('completion storage failure fails closed and a new entry can recover', async () => {
  const read = f.feedback.isCompleted;
  f.feedback.isCompleted = async () => { throw new Error('storage unavailable'); };
  await enter([inAppMessage('storage')]);
  expect(f.controller.getSnapshot().phase).toBe('empty');
  expect(messages()).toHaveLength(0);
  f.feedback.isCompleted = read;
  await tick(() => { f.enter('recovered'); f.respond([inAppMessage('storage')]); });
  expect(messages()).toHaveLength(1);
});

test('completion lookup deadline cannot produce a late popup', async () => {
  jest.useFakeTimers();
  let release;
  f.feedback.isCompleted = () => new Promise(resolve => { release = resolve; });
  await enter([inAppMessage('slow-storage')]);
  await tick(() => jest.advanceTimersByTime(51));
  await tick(() => release(false));
  expect(f.controller.getSnapshot().phase).toBe('empty');
  expect(messages()).toHaveLength(0);
});

test('page matching and local completion skip candidates without consuming a slot', async () => {
  const excluded = inAppMessage('excluded'); excluded.pages = ['/settings/*'];
  const included = inAppMessage('included'); included.pages = ['/reports/*'];
  f.completed.add(JSON.stringify(['A', 'complete']));
  await mount(React.createElement(InAppMessages, { controller: f.controller }));
  await tick(() => { f.enter('report', '/reports/one/?source=test#top'); f.respond([excluded, inAppMessage('complete'), included]); });
  expect(f.requests[0].input.path).toBe('/reports/one');
  await layout();
  expect(f.admissions.map(x => x.deliveryId)).toEqual(['included']);
});

test('repeated layout and concurrent actions wait for shown admission', async () => {
  const admit = f.feedback.admit;
  let release;
  f.feedback.admit = input => input.type === 'shown' ? new Promise(resolve => { release = async () => resolve(await admit(input)); }) : admit(input);
  let actions;
  await enter([inAppMessage('ordering')], React.createElement(InAppMessages, {
    controller: f.controller, render: (message, value) => { actions = value; return React.createElement(View); },
  }));
  const onLayout = root.root.findAllByProps({ testID: 'galinum-custom' })[0].props.onLayout;
  let first, second;
  await tick(() => { onLayout(); onLayout(); first = actions.dismiss(); second = actions.dismiss(); });
  expect(f.admissions).toHaveLength(0);
  await tick(async () => { await release(); await Promise.all([first, second]); });
  expect(f.admissions.map(x => x.type)).toEqual(['shown', 'dismissed']);
});

test('identity change while shown admission waits prevents terminal admission and navigation', async () => {
  const admit = f.feedback.admit;
  let release;
  f.feedback.admit = input => new Promise(resolve => { release = async () => resolve(await admit(input)); });
  let actions;
  await enter([inAppMessage('pending')], React.createElement(InAppMessages, {
    controller: f.controller, render: (message, value) => { actions = value; return React.createElement(View); },
  }));
  let click;
  await tick(() => { root.root.findAllByProps({ testID: 'galinum-custom' })[0].props.onLayout(); click = actions.click(); });
  await tick(() => f.session({ userId: 'B', appConfirmed: false, facts: 1 }));
  await tick(async () => { await release(); await click; });
  expect(f.admissions.map(x => [x.userId, x.type])).toEqual([['A', 'shown']]);
  expect(f.destinations).toHaveLength(0);
});

test('terminal storage failure prevents navigation until durable retry succeeds', async () => {
  const message = inAppMessage('destination');
  message.content.cta = { label: 'Open', destination: { kind: 'website', url: 'https://example.com' } };
  f.fail('clicked');
  await enter([message]); await layout();
  await tick(() => button('Open').props.onPress());
  expect(f.destinations).toHaveLength(0);
  expect(messages()).toHaveLength(1);
  f.fail();
  await tick(() => button('Try again').props.onPress());
  expect(f.destinations).toEqual(['https://example.com']);
  expect(new Set(f.admissions.filter(x => x.type === 'clicked').map(x => x.feedbackId)).size).toBe(1);
});

test('automatic theme uses the native color scheme', async () => {
  jest.spyOn(require('react-native'), 'useColorScheme').mockReturnValue('dark');
  await enter([inAppMessage('theme')]);
  expect(messages()[0].props.style[1].backgroundColor).toBe('#18181b');
});


test('repeated disposal cannot remove a replacement client controller', () => {
  const { getInAppController, InAppController } = require('../src/inapp-controller.ts');
  const options = { id: () => 'replacement', openDestination: async () => {} };
  f.controller.dispose();
  const replacement = getInAppController(f.client, f.feedback, options);
  f.controller.dispose();
  expect(getInAppController(f.client, f.feedback, options)).toBe(replacement);
  expect(() => new InAppController(f.client, f.feedback, options)).toThrow('one in-app controller');
  replacement.dispose();
});

test.each([false, true])('readiness closes a committed entry without restoring presentation, native shown=%s', async shown => {
  AppState.currentState = 'active';
  const tree = ready => React.createElement(React.Fragment, null,
    React.createElement(InAppLifecycle, { controller: f.controller, routeKey: 'same-route', path: '/home', navigationReady: ready }),
    React.createElement(InAppMessages, { controller: f.controller }));
  await mount(tree(true));
  await tick(() => f.respond([inAppMessage('one'), inAppMessage('two')]));
  const capture = f.controller.getSnapshot().capture;
  const oldLayout = messages()[0].props.onLayout;
  const dismiss = root.root.findAllByProps({ accessibilityLabel: 'Dismiss message' }).find(node => typeof node.props.onPress === 'function').props.onPress;
  if (shown) await layout();
  await tick(() => root.update(tree(false)));
  expect(messages()).toHaveLength(0);
  await tick(() => root.update(tree(true)));
  await tick(() => { oldLayout(); dismiss(); f.session({ facts: 1 }); });
  expect(f.requests).toHaveLength(1);
  expect(f.controller.getSnapshot()).toEqual({ phase: 'consumed', capture });
  expect(messages()).toHaveLength(0);
  expect(f.admissions.map(x => x.type)).toEqual(shown ? ['shown'] : []);
});

test.each(['empty', 'failed', 'deadline'])('readiness does not reopen an entry settled %s', async outcome => {
  jest.useFakeTimers();
  await mount(React.createElement(InAppMessages, { controller: f.controller }));
  await tick(() => { f.controller.foreground(true); f.controller.navigate('same-route', '/home', true); });
  const capture = f.controller.getSnapshot().capture;
  await tick(() => {
    if (outcome === 'empty') f.respond([]);
    else if (outcome === 'failed') f.requests[0].reject(new Error('offline'));
    else jest.advanceTimersByTime(51);
  });
  expect(f.controller.getSnapshot().phase).toBe('empty');
  await tick(() => { f.controller.navigate('same-route', '/home', false); f.controller.navigate('same-route', '/home/?ignored=yes#top', true); });
  await tick(() => { f.respond([inAppMessage('late')], 0); f.session({ facts: 1 }); });
  expect(f.requests).toHaveLength(1);
  expect(f.controller.getSnapshot()).toEqual({ phase: 'empty', capture });
  expect(messages()).toHaveLength(0);
});

test.each(['decision', 'completion', 'candidate'])('readiness permanently cancels uncommitted %s work', async pending => {
  let release;
  if (pending === 'completion') f.feedback.isCompleted = () => new Promise(resolve => { release = resolve; });
  await tick(() => { f.controller.foreground(true); f.controller.navigate('same-route', '/home', true); });
  const capture = f.controller.getSnapshot().capture;
  if (pending !== 'decision') await tick(() => f.respond([inAppMessage('late')]));
  expect(f.controller.getSnapshot().phase).toBe(pending === 'candidate' ? 'ready' : 'loading');
  await tick(() => { f.controller.navigate('same-route', '/home', false); f.controller.navigate('same-route', '/home', true); });
  expect(f.requests[0].signal.aborted).toBe(true);
  await tick(() => { if (pending === 'decision') f.respond([inAppMessage('late')]); else release?.(false); });
  await tick(() => f.session({ facts: 1 }));
  await mount(React.createElement(InAppMessages, { controller: f.controller }));
  expect(f.requests).toHaveLength(1);
  expect(f.controller.getSnapshot()).toEqual({ phase: 'empty', capture });
  expect(messages()).toHaveLength(0);
  expect(f.admissions).toHaveLength(0);
});

test.each(['key', 'path', 'foreground', 'owner', 'userId', 'confirmation'])('a genuine %s boundary can open selection after readiness closes an entry', async boundary => {
  await tick(() => { f.controller.foreground(true); f.controller.navigate('same-route', '/home', true); f.respond([]); });
  const first = f.requests[0].input;
  await tick(() => f.controller.navigate('same-route', '/home', false));
  await tick(() => {
    if (boundary === 'key') f.controller.navigate('next-route', '/home', false);
    else if (boundary === 'path') f.controller.navigate('same-route', '/next', false);
    else if (boundary === 'foreground') { f.controller.foreground(false); f.controller.foreground(true); }
    else if (boundary === 'confirmation') { f.session({ appConfirmed: false }); f.session({ appConfirmed: true }); }
    else f.session({ [boundary]: 'B' });
  });
  expect(f.requests).toHaveLength(1);
  await tick(() => f.controller.navigate(boundary === 'key' ? 'next-route' : 'same-route', boundary === 'path' ? '/next' : '/home', true));
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1].input.entryId).not.toBe(first.entryId);
  expect(f.requests[1].input.requestId).not.toBe(first.requestId);
  await mount(React.createElement(InAppMessages, { controller: f.controller }));
  await tick(() => f.respond([inAppMessage('fresh')]));
  expect(messages()).toHaveLength(1);
  await layout();
  expect(f.admissions.map(x => x.deliveryId)).toEqual(['fresh']);
});

test('readiness fences a terminal action waiting for shown admission after readiness returns', async () => {
  const admit = f.feedback.admit;
  let release;
  f.feedback.admit = input => input.type === 'shown' ? new Promise(resolve => { release = async () => resolve(await admit(input)); }) : admit(input);
  let actions;
  const message = inAppMessage('waiting');
  message.content.cta = { label: 'Open', destination: { kind: 'website', url: 'https://example.com' } };
  await enter([message], React.createElement(InAppMessages, {
    controller: f.controller, render: (value, captured) => { actions = captured; return React.createElement(View); },
  }));
  let click;
  await tick(() => { root.root.findAllByProps({ testID: 'galinum-custom' })[0].props.onLayout(); click = actions.click(); });
  await tick(() => { f.controller.navigate('home', '/', false); f.controller.navigate('home', '/', true); });
  await tick(async () => { await release(); await click; });
  expect(f.requests).toHaveLength(1);
  expect(f.admissions.map(x => x.type)).toEqual(['shown']);
  expect(f.destinations).toHaveLength(0);
  expect(messages()).toHaveLength(0);
});

test.each(['shown', 'clicked'].flatMap(pending => ['unmount', 'replacement'].map(boundary => [pending, boundary])))
('pending %s admission cannot continue after host %s', async (pending, boundary) => {
  const admit = f.feedback.admit;
  let release;
  f.feedback.admit = input => input.type === pending
    ? new Promise(resolve => { release = async () => resolve(await admit(input)); }) : admit(input);
  let actions;
  const message = inAppMessage('detached');
  message.content.cta = { label: 'Open', destination: { kind: 'website', url: 'https://example.com' } };
  const host = key => React.createElement(InAppMessages, {
    key, controller: f.controller, render: (value, captured) => { actions = captured; return React.createElement(View); },
  });
  await enter([message, inAppMessage('unused')], host('original'));
  const capture = f.controller.getSnapshot().capture;
  const onLayout = root.root.findAllByProps({ testID: 'galinum-custom' })[0].props.onLayout;
  const oldActions = actions;
  let click;
  await tick(() => { onLayout(); click = oldActions.click(); });
  expect(release).toEqual(expect.any(Function));
  await tick(() => root.update(boundary === 'unmount' ? null : host('replacement')));
  await tick(async () => { await release(); await click; });
  expect(f.admissions.map(x => x.type)).toEqual(pending === 'shown' ? ['shown'] : ['shown', 'clicked']);
  expect(f.admissions.every(x => x.feedbackId === capture.entryId + ':' + x.type && x.shownFeedbackId === capture.entryId + ':shown')).toBe(true);
  expect(f.completed.has(JSON.stringify(['A', 'detached']))).toBe(pending === 'clicked');
  expect(f.destinations).toEqual([]);
  await tick(() => root.update(host('remounted')));
  await tick(async () => { onLayout(); await oldActions.retry(); await oldActions.click(); });
  expect(f.controller.getSnapshot()).toEqual({ phase: 'consumed', capture });
  expect(root.root.findAllByProps({ testID: 'galinum-custom' })).toHaveLength(0);
  expect(f.requests).toHaveLength(1);
  expect(f.admissions).toHaveLength(pending === 'shown' ? 1 : 2);
});

test.each(['shown', 'clicked'].flatMap(pending => ['same-entry', 'new-entry'].map(reuse => [pending, reuse])))
('pending %s admission stays fenced when the same host and message return in %s', async (pending, reuse) => {
  const admit = f.feedback.admit;
  let release;
  let blocked = false;
  f.feedback.admit = input => {
    if (input.type !== pending || blocked) return admit(input);
    blocked = true;
    return new Promise(resolve => { release = async () => resolve(await admit(input)); });
  };
  const host = Symbol('reused-host');
  const detach = f.controller.attach(host);
  const message = inAppMessage('reused');
  message.content.cta = { label: 'Open', destination: { kind: 'website', url: 'https://example.com' } };
  await tick(() => { f.enter(); f.respond([message]); });
  const capture = f.controller.getSnapshot().capture;
  f.controller.commit(host, capture, message);
  f.controller.presented(host, capture, message);
  const actions = f.controller.actions(host, capture, message);
  const click = actions.click();
  await tick();
  expect(release).toEqual(expect.any(Function));
  detach();
  const detachAgain = f.controller.attach(host);
  if (reuse === 'new-entry') {
    await tick(() => { f.enter('next'); f.respond([message]); });
    const next = f.controller.getSnapshot().capture;
    f.controller.commit(host, next, message);
    f.controller.presented(host, next, message);
    await tick();
  }
  const replacement = f.controller.getSnapshot();
  await tick(async () => { await release(); await click; await actions.retry(); await actions.click(); });
  expect(f.destinations).toEqual([]);
  expect(f.controller.getSnapshot()).toBe(replacement);
  expect(f.admissions.filter(x => x.feedbackId.startsWith(capture.entryId + ':')).map(x => x.type))
    .toEqual(pending === 'shown' ? ['shown'] : ['shown', 'clicked']);
  if (reuse === 'same-entry') expect(replacement).toEqual({ phase: 'consumed', capture });
  else {
    const nextActions = f.controller.actions(host, replacement.capture, message);
    await tick(() => nextActions.click());
    expect(f.destinations).toEqual(['https://example.com']);
    expect(f.admissions.filter(x => x.feedbackId.startsWith(replacement.capture.entryId + ':')).map(x => x.type)).toEqual(['shown', 'clicked']);
  }
  detachAgain();
});

test.each(['unmount', 'replacement'].flatMap(boundary => ['resolve', 'reject'].map(outcome => [boundary, outcome])))
('destination completion after host %s cannot change detached state on %s', async (boundary, outcome) => {
  const { InAppController } = require('../src/inapp-controller.ts');
  let release, reject;
  let id = 0;
  f.controller.dispose();
  f.controller = new InAppController(f.client, f.feedback, {
    id: () => 'destination-' + ++id,
    openDestination: destination => {
      f.destinations.push(destination.url);
      return new Promise((resolve, fail) => { release = resolve; reject = fail; });
    },
  });
  let actions;
  const message = inAppMessage('opening');
  message.content.cta = { label: 'Open', destination: { kind: 'website', url: 'https://example.com' } };
  const host = key => React.createElement(InAppMessages, {
    key, controller: f.controller, render: (value, captured) => { actions = captured; return React.createElement(View); },
  });
  await mount(host('original'));
  await tick(() => { f.controller.navigate('home', '/', true); f.controller.foreground(true); f.respond([message]); });
  let click;
  await tick(() => { root.root.findAllByProps({ testID: 'galinum-custom' })[0].props.onLayout(); click = actions.click(); });
  expect(f.destinations).toEqual(['https://example.com']);
  expect(f.admissions.map(x => x.type)).toEqual(['shown', 'clicked']);
  await tick(() => root.update(boundary === 'unmount' ? null : host('replacement')));
  const detached = f.controller.getSnapshot();
  await tick(async () => {
    if (outcome === 'resolve') { release(); await click; }
    else { reject(new Error('Destination failed')); await expect(click).rejects.toThrow('Destination failed'); }
  });
  expect(f.controller.getSnapshot()).toBe(detached);
  expect(detached.error).toBeUndefined();
  expect(f.completed.has(JSON.stringify(['A', 'opening']))).toBe(true);
  expect(f.requests).toHaveLength(1);
  await tick(() => root.update(host('remounted')));
  expect(root.root.findAllByProps({ testID: 'galinum-custom' })).toHaveLength(0);
});
