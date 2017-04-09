var saku, postForm;
var UPLOADING_MSG = 'Uploading...';



connSM.on('synced', postSM.feeder('sync'));
connSM.on('dropped', postSM.feeder('desync'));
connSM.on('desynced', postSM.feeder('desync'));

postSM.act('* + desync -> none', function () {
	if (postForm) {
		postForm.$el.removeClass('editing');
		postForm.$input.val('');
		postForm.finish();
	}
	$('aside').remove();
});

postSM.act('none + sync, draft, alloc + done -> ready', function () {
	if (postForm) {
		postForm.remove();
		postForm = null;
		saku = null;
	}
	insert_pbs();

	var m = window.location.hash.match(/^#q(\d+)$/);
	if (m) {
		var id = parseInt(m[1], 10);
		if ($('#' + id).hasClass('highlight')) {
			window.location.hash = '#' + id;
			open_post_box(id);
			postForm.add_ref(id);
		}
	}
});

postSM.act('ready + new -> draft', function (aside) {
	var op = null;
	var $sec = aside.closest('section');
	if ($sec.length) {
		op = extract_num($sec);
	}
	else {
		$sec = $('<section/>');
	}
	saku = new Saku({op: op});
	postForm = new ComposerView({model: saku, dest: aside, thread: $sec});
});

postSM.preflight('draft', function (aside) {
	return aside.is('aside');
});

postSM.act('draft + alloc -> alloc', function (msg) {
	postForm.on_allocation(msg);
});

$DOC.on('click', 'aside a', _.wrap(function () {
	postSM.feed('new', $(this).parent());
}, with_dom));

$DOC.on('keydown', handle_shortcut);

var vapor = 0, wombo = 0, eject = 0;

function handle_shortcut(event) {
	var k = event.which;
	if (vapor < 0 || wombo < 0) {
		if (event.shiftKey && k == [69,74,69,67,84,49][eject]) {
			if (++eject >= 6) {
				vapor = wombo = eject = 0;
				ComposerView.prototype.word_filter = function (w) { return w; };
				flash_bg('white');
			}
		}
		else
			eject = 0;
	}
	else if (event.shiftKey && k == 86) {
		if (++vapor > 10) {
			vapor = -1;
			if (postForm)
				postForm.$input.val('');
			flash_bg('#f98aa5');
			event.stopImmediatePropagation();
			event.preventDefault();
		}
	}
	else
		vapor = wombo = 0;

	if (!event.altKey)
		return;

	var used = false;
	switch (event.which) {
	case shortcutKeys['new']:
		var $aside = THREAD ? $('aside') : $ceiling.next();
		if ($aside.is('aside') && $aside.length == 1) {
			with_dom(function () {
				postSM.feed('new', $aside);
			});
			used = true;
		}
		break;
	case shortcutKeys.togglespoiler:
		if (postForm) {
			postForm.on_toggle(event);
			used = true;
		}
		break;
	case shortcutKeys.done:
		if (postForm) {
			if (!postForm.submit.attr('disabled')) {
				postForm.finish_wrapped();
				used = true;
			}
		}
		break;
	}

	if (used) {
		event.stopImmediatePropagation();
		event.preventDefault();
	}
}

function open_post_box(num) {
	var a = $('#' + num);
	postSM.feed('new', a.is('section')
			? a.children('aside') : a.siblings('aside'));
}

function make_reply_box() {
	return $('<aside class="act"><a>Reply</a></aside>');
}

function insert_pbs() {
	if (config.READ_ONLY || readOnly.indexOf(BOARD) >= 0)
		return;
	if (THREAD ? $('aside').length : $ceiling.next().is('aside'))
		return;
	make_reply_box().appendTo('section');
	if (!nashi.upload && BUMP)
		$ceiling.after('<aside class="act"><a>New thread</a></aside>');
}

function get_nonces() {
	var nonces;
	if (window.localStorage) {
		try {
			nonces = JSON.parse(localStorage.postNonces);
		}
		catch (e) {}
	}
	else {
		nonces = ComposerView.nonces;
	}
	return nonces || {};
}

function save_nonces(nonces) {
	if (window.localStorage)
		localStorage.postNonces = JSON.stringify(nonces);
	else
		ComposerView.nonces = nonces;
}

function today_id() {
	return Math.floor(new Date().getTime() / (1000*60*60*24));
}

function create_nonce() {
	var nonces = get_nonces();
	var nonce = random_id();
	nonces[nonce] = {
		tab: TAB_ID,
		day: today_id(),
	};
	save_nonces(nonces);
	return nonce;
}

function expire_nonces() {
	if (!window.localStorage)
		return;
	// we need a lock on postNonces really
	var nonces = get_nonces();

	// people messing with their system clock will mess with expiry, doh
	var changed = false;
	var yesterday = today_id() - 1;
	for (var nonce in nonces) {
		if (nonces[nonce].day >= yesterday)
			continue;
		delete nonces[nonce];
		changed = true;
	}

	if (changed)
		save_nonces(nonces);
}
setTimeout(expire_nonces, Math.floor(Math.random()*5000));

function destroy_nonce(nonce) {
	var nonces = get_nonces();
	if (!nonces[nonce])
		return;
	delete nonces[nonce];
	save_nonces(nonces);
}

var Saku = Backbone.Model.extend({
	idAttribute: 'num',
});

var ComposerView = Backbone.View.extend({

events: {
	'input #subject': model_link('subject'),
	'keydown #trans': 'on_key_down',
	'click #done': 'finish_wrapped',
	'click #toggle': 'on_toggle',
},

initialize: function (dest) {

	this.listenTo(this.model, 'change', this.render_buttons);
	this.listenTo(this.model, 'change:spoiler', this.render_spoiler_pane);

	var attrs = this.model.attributes;
	var op = attrs.op;
	var post = op ? $('<article/>') : this.options.thread;
	this.setElement(post[0]);

	this.buffer = $('<p/>');
	this.line_buffer = $('<p/>');
	this.meta = $('<header><a class="nope"><b/></a> <time/></header>');
	this.$input = $('<textarea/>', {
		name: 'body', id: 'trans', rows: '1', "class": 'themed',
	});
	this.submit = $('<input>', {
		id: 'done', type: 'button', value: 'Done',
	});
	this.$subject = $('<input/>', {
		id: 'subject',
		'class': 'themed',
		maxlength: config.SUBJECT_MAX_LENGTH,
		width: '80%',
	});
	this.blockquote = $('<blockquote/>');
	this.$sizer = $('<pre/>').appendTo('body');
	this.pending = '';
	this.line_count = 1;
	this.char_count = 0;
	this.imouto = new OneeSama(function (ref) {
		if (config.BOARDS.indexOf(ref) >= 0 ) {
			var $s = $('>' + ref);
			var board = ref;
		}
		else if (!isNaN(ref)) {
			var $s = $('#' + ref);
			var num = ref;
		}
		else {
			this.callback(safe('<a class="nope">&gt;&gt;' + ref
					+ '</a>'));
			return;
		}
		if (!$s.is('section'))
			$s = $s.closest('section');
		// Clean this up later
		// Question: what does $s.is('section') mean? Where is
		// that function?
		if (num && !board) {
			this.callback(this.post_ref(num, extract_num($s)));
		}
		else if (!num && board) {
			this.callback(this.board_ref(board));
		}

	});
	this.imouto.callback = inject;
	this.imouto.op = THREAD;
	this.imouto.state = [S_BOL, 0];
	this.imouto.buffer = this.buffer;
	this.imouto.hook('spoilerTag', touchable_spoiler_tag);
	oneeSama.trigger('imouto', this.imouto);

	shift_replies(this.options.thread);
	this.blockquote.append(this.buffer, this.line_buffer, this.$input);
	post.append(this.meta, this.blockquote);
	if (!op) {
		post.append('<label for="subject">Subject: </label>',
				this.$subject);
		this.blockquote.hide();
	}
// Word filters are broken when they are always on
//	if (config.WORDFILTERS_ENABLED)
//		$.getScript(mediaURL + 'js/wordfilter.js');
	
	this.uploadForm = this.make_upload_form();
	post.append(this.uploadForm);
	oneeSama.trigger('draft', post);

	this.propagate_ident();
	this.options.dest.replaceWith(post);

	this.$input.input(this.on_input.bind(this, undefined));

	if (op) {
		this.resize_input();
		this.$input.focus();
	}
	else {
		post.after('<hr/>');
		this.$subject.focus();
	}
	$('aside').remove();

	preload_panes();
},

propagate_ident: function () {
	if (this.model.get('num'))
		return;
	var parsed = parse_name($name.val().trim());
	var haveTrip = parsed[1] || parsed[2];
	var meta = this.meta;
	var $b = meta.find('b');
	if (parsed[0])
		$b.text(parsed[0] + ' ');
	else
		$b.text(haveTrip ? '' : ANON);
	if (haveTrip)
		$b.append($.parseHTML(' <code>!?</code>'));
	oneeSama.trigger('fillMyName', $b);
	var email = $email.val().trim();
	if (is_noko(email))
		email = '';
	var tag = meta.children('a:first');
	if (email)
		tag.attr({href: 'mailto:' + email, target: '_blank',
				'class': 'email'});
	else
		tag.removeAttr('href').removeAttr('target').attr('class',
				'nope');
},

on_allocation: function (msg) {
	var num = msg.num;
	ownPosts[num] = true;
	this.model.set({num: num});
	this.flush_pending();
	var header = $(flatten(oneeSama.atama(msg)).join(''));
	this.meta.replaceWith(header);
	this.meta = header;
	var op = this.model.get('op');
	if (op)
		this.$el.addClass('editing');
	else
		spill_page();
	this.$el.attr('id', num);

	if (msg.image)
		this.insert_uploaded(msg.image);
	if (num == MILLION)
		this.add_own_gravitas(msg);

	if (this.uploadForm)
		this.uploadForm.append(this.submit);
	else
		this.blockquote.after(this.submit);
	if (!op) {
		this.$subject.siblings('label').andSelf().remove();
		this.blockquote.show();
		this.resize_input();
		this.$input.focus();
	}

	window.onbeforeunload = function () {
		return "You have an unfinished post.";
	};
},

on_image_alloc: function (msg) {
	var attrs = this.model.attributes;
	if (attrs.cancelled)
		return;
	if (!attrs.num && !attrs.sentAllocRequest) {
		send([INSERT_POST, this.make_alloc_request(null, msg)]);
		this.model.set({sentAllocRequest: true});
	}
	else {
		send([INSERT_IMAGE, msg]);
	}
},

entry_scroll_lock: function () {
	/* NOPE */
	if (lockTarget == PAGE_BOTTOM) {
		/* Special keyup<->down case */
		var height = $DOC.height();
		if (height > lockKeyHeight)
			window.scrollBy(0, height - lockKeyHeight + 1);
	}
},

on_key_down: function (event) {
	if (lockTarget == PAGE_BOTTOM) {
		lockKeyHeight = $DOC.height();
		_.defer($.proxy(this, 'entry_scroll_lock'));
	}
	switch (event.which) {
	case 13:
		event.preventDefault();
		/* fall-through */
	case 32:
		var c = event.which == 13 ? '\n' : ' ';
		// predict result
		var input = this.$input[0];
		var val = this.$input.val();
		val = val.slice(0, input.selectionStart) + c +
				val.slice(input.selectionEnd);
		if (vapor >= 0 || c == '\n')
			this.on_input(val);
		break;
	default:
		handle_shortcut(event);
	}
},

on_input: function (val) {
	var $input = this.$input;
	var start = $input[0].selectionStart, end = $input[0].selectionEnd;
	if (val === undefined)
		val = $input.val();

	// dirty flag for writing back to the text box
	var changed = false;
	// character range we should not mangle
	var ward = 0, ward_len = 0;

	/* Turn YouTube links into proper refs */
	while (true) {
		var m = val.match(youtube_url_re);
		if (!m)
			break;
		/* Substitute */
		var t = m[4] || '';
		t = this.find_time_arg(m[3]) || this.find_time_arg(m[1]) || t;
		if (t[0] == '?')
			t = '#' + t.substr(1);
		var v = '>>>/watch?v=' + m[2] + t;
		var old = m[0].length;
		val = val.substr(0, m.index) + v + val.substr(m.index + old);
		changed = true;
		ward = m.index;
		ward_len = v.length;
		/* Compensate caret position */
		if (m.index < start) {
			var diff = old - v.length;
			start -= diff;
			end -= diff;
		}
	}
	/* and SoundCloud links */
	while (false) {
		var m = val.match(soundcloud_url_re);
		if (!m)
			break;
		var sc = '>>>/soundcloud/' + m[1];
		var old = m[0].length;
		val = val.substr(0, m.index) + sc + val.substr(m.index + old);
		changed = true;
		ward = m.index;
		ward_len = sc.length;
		if (m.index < start) {
			var diff = old - sc.length;
			start -= diff;
			end -= diff;
		}
	}
	/* and Twitter links */
	while (true) {
		var m = val.match(twitter_url_re);
		if (!m)
			break;
		var tw = '>>>/@' + m[1] + '/' + m[2];
		var old = m[0].length;
		val = val.substr(0, m.index) + tw + val.substr(m.index + old);
		changed = true;
		ward = m.index;
		ward_len = tw.length;
		if (m.index < start) {
			var diff = old - tw.length;
			start -= diff;
			end -= diff;
		}
	}
	if (vapor < 0) {
		if (!ward_len) {
			// may have already converted from URL to >>ref, ward that too
			var m = val.match(ref_re);
			if (m) {
				ward = m.index;
				ward_len = m[0].length;
			}
		}
		var vaped = this.vaporize(val, ward, ward+ward_len);
		if (vaped != val) {
			val = vaped;
			changed = true;
		}
	}
	if (changed)
		$input.val(val);

	var len = val.length, lim = 0;
	var nl = val.lastIndexOf('\n');
	if (nl >= 0) {
		var ok = val.substr(0, nl);
		ok = this.word_filter(ok);
		val = val.substr(nl+1);
		$input.val(val);
		if (this.model.get('sentAllocRequest') || /[^ ]/.test(ok))
			this.commit(ok + '\n');
	}
	else if (vapor < 0 && !ward_len) {
		if (len > 3)
			lim = len - 3;
	}
	else {
		var rev = val.split('').reverse().join('');
		var m = rev.match(/^(\s*\S+\s+\S+)\s+(?=\S)/);
		if (m)
			lim = len - m[1].length;
	}

	if (lim > 0) {
		var destiny = val.substr(0, lim);
		destiny = this.word_filter(destiny);
		this.commit(destiny);
		val = val.substr(lim);
		start -= lim;
		end -= lim;
		$input.val(val);
		$input[0].setSelectionRange(start, end);
	}

	$input.attr('maxlength', MAX_POST_CHARS - this.char_count);
	this.resize_input(val);
},

vaporize: function (text, ward_start, ward_end) {
	var aesthetic = '';
	for (var i = 0; i < text.length; i++) {
		var c = text.charCodeAt(i);
		if (i >= ward_start && i < ward_end) {
		}
		else if (c > 32 && c < 127)
			c += 0xfee0;
		else if (c == 32)
			c = 0x3000;
		aesthetic += String.fromCharCode(c);
	}
	return aesthetic;
},

word_filter: function (words) {
// DIRTY HACK PLEASE FIX IN THE MORNING
        if (words.indexOf('?v=') > -1)
                return words;
	return words.replace(/(\w+)/g, function (orig) {
		var word = {
			'filter': 'improver',
			'filters': 'improves',
			'filtering': 'improving',
			'filtered': 'improved',
			'doushio': 'どうしお',
			'anime': 'アニメ',
			'weaboo': 'gaijin',
			'weaboos': 'gaijin',
			'mad': '［ＭＡＤ］',
			'angry': '［ＭＡＤ］',
			'enrage': '［ＭＡＤ］',
			'enraged': '［ＭＡＤ］',
			'bothered': '［ＭＡＤ］',
			'touhou': '2hu',
			'nigger': 'roody-poo',
			'niggers': 'roody-poos',
			'nigga': 'roody-poo',
			'niggas': 'roody-poos',
			'nig': 'roody-poo',
			'faggot': 'candy-ass',
			'fags': 'candy-asses',
			'cuck': 'A H H H HH H H F U C K I L OV E DICKS',
			'cucks': 'I  CANNOT STOP JACKING IT',
			'smh': 'baka',
			'tbh': 'desu',
			'fam': 'senpai',
			'pajeet': 'hard-working immigrant',
			'pajeets': 'hard-working immigrants',
			'jews': 'arabs',
			'arabs': 'jews',
			'overwatch': 'OVERMAN',
			'MAGA': 'Politics do NOT belong on this board'
                }[orig.toLowerCase()];
		if (word && word.indexOf(',') >= 0) {
	                        word = word.split(',');
				word = word[Math.floor(Math.random() * word.length)];
			}
		return (word || orig);
        });
			
},

add_ref: function (ref) {
	if (config.BOARDS.indexOf(ref) < 0) {
		/* If a >>link exists, put this one on the next line */
		var num = ref;
		var $input = this.$input;
		var val = $input.val();
		if (/^>>\d+$/.test(val)) {
			$input.val(val + '\n');
			this.on_input();
			val = $input.val();
		}
		$input.val(val + '>>' + num);
		$input[0].selectionStart = $input.val().length;
		this.on_input();
		$input.focus();
	}
	else {
		var board = ref;
		$input.val(val + '>>>/' + board + '/');
		$input[0].selectionStart = $input.val().length;
		this.on_input();
		$input.focus();
	}
},

find_time_arg: function (params) {
	if (!params || params.indexOf('t=') < 0)
		return false;
	params = params.split('&');
	for (var i = 0; i < params.length; i++) {
		var pair = '#' + params[i];
		if (youtube_time_re.test(pair))
			return pair;
	}
	return false;
},

resize_input: function (val) {
	var $input = this.$input;
	if (typeof val != 'string')
		val = $input.val();

	this.$sizer.text(val);
	var left = $input.offset().left - this.$el.offset().left;
	var size = this.$sizer.width() + INPUT_ROOM;
	size = Math.max(size, inputMinSize - left);
	$input.css('width', size + 'px');
},

dispatch: function (msg) {
	var a = msg.arg;
	switch (msg.t) {
		case 'alloc':
			this.on_image_alloc(a);
			break;
		case 'error':
			this.upload_error(a);
			break;
		case 'status':
			this.upload_status(a);
			break;
	}
},

upload_status: function (msg) {
	if (this.model.get('cancelled'))
		return;
	this.model.set('uploadStatus', msg);
},

upload_error: function (msg) {
	if (this.model.get('cancelled'))
		return;
	this.model.set({uploadStatus: msg, uploading: false});
	if (this.uploadForm)
		this.uploadForm.find('input[name=alloc]').remove();
},

upload_finished_fallback: function () {
	// this is just a fallback message for when we can't tell
	// if there was an error due to cross-origin restrictions
	var a = this.model.attributes;
	var stat = a.uploadStatus;
	if (!a.cancelled && a.uploading && (!stat || stat == UPLOADING_MSG))
		this.model.set('uploadStatus', 'Unknown result.');
},

insert_uploaded: function (info) {
	var form = this.uploadForm, op = this.model.get('op');
	insert_image(info, form.siblings('header'), !op);
	this.$imageInput.siblings('strong').andSelf().add(this.$cancel
			).remove();
	form.find('#toggle').remove();
	this.flush_pending();
	this.model.set({uploading: false, uploaded: true,
			sentAllocRequest: true});

	/* Stop obnoxious wrap-around-image behaviour */
	var $img = this.$el.find('img');
	this.blockquote.css({
		'margin-left': $img.css('margin-right'),
		'padding-left': $img.width(),
	});

	this.resize_input();
},

make_alloc_request: function (text, image) {
	var msg = {nonce: create_nonce()};
	function opt(key, val) {
		if (val)
			msg[key] = val;
	}
	opt('name', $name.val().trim());
	opt('email', $email.val().trim());
	opt('subject', this.$subject.val().trim());
	opt('frag', text);
	opt('image', image);
	opt('op', this.model.get('op'));
	return msg;
},

// Client-side, run when text ought to be sent to the server
commit: function (text) {
	var lines;

	if (text.indexOf('\n') >= 0) {
		lines = text.split('\n');
		this.line_count += lines.length - 1;
		var breach = this.line_count - MAX_POST_LINES + 1;
		if (breach > 0) {
			for (var i = 0; i < breach; i++)
				lines.pop();
			text = lines.join('\n');
			this.line_count = MAX_POST_LINES;
		}
	}
	var left = MAX_POST_CHARS - this.char_count;
	if (left < text.length)
		text = text.substr(0, left);
	if (!text)
		return;
	this.char_count += text.length;

	/* Either get an allocation or send the committed text */
	var attrs = this.model.attributes;
	if (!attrs.num && !attrs.sentAllocRequest) {
		send([INSERT_POST, this.make_alloc_request(text, null)]);
		this.model.set({sentAllocRequest: true});
	}
	else if (attrs.num)
		send(text);
	else
		this.pending += text;

	/* Add it to the user's display */
	var line_buffer = this.line_buffer;
	if (lines) {
		lines[0] = line_buffer.text() + lines[0];
		line_buffer.text(lines.pop());
		for (var i = 0; i < lines.length; i++)
			this.imouto.fragment(lines[i] + '\n');
	}
	else {
		line_buffer.append(document.createTextNode(text));
		line_buffer[0].normalize();
	}
},

flush_pending: function () {
	if (this.pending) {
		send(this.pending);
		this.pending = '';
	}
},

cancel: function () {
	if (this.model.get('uploading')) {
		this.$iframe.remove();
		this.$iframe = $('<iframe></iframe>', {
			src: '', name: 'upload', id: 'hidden-upload',
		}).appendTo('body');
		this.upload_error('');
		this.model.set({cancelled: true});
	}
	else
		this.finish_wrapped();
},

finish: function () {
	if (this.model.get('num')) {
		this.flush_pending();
		this.commit(this.word_filter(this.$input.val()));
		this.$input.remove();
		this.submit.remove();
		if (this.uploadForm)
			this.uploadForm.remove();
		if (this.$iframe) {
			this.$iframe.remove();
			this.$iframe = null;
		}
		this.imouto.fragment(this.line_buffer.text());
		this.buffer.replaceWith(this.buffer.contents());
		this.line_buffer.remove();
		this.blockquote.css({'margin-left': '', 'padding-left': ''});
		send([FINISH_POST]);
		this.preserve = true;
	}
	postSM.feed('done');
},

remove: function () {
	if (!this.preserve) {
		if (!this.model.get('op'))
			this.$el.next('hr').remove();
		this.$el.remove();
	}
	this.$sizer.remove();
	if (this.$iframe) {
		this.$iframe.remove();
		this.$iframe = null;
	}
	this.stopListening();
	window.onbeforeunload = null;
},

render_buttons: function () {
	var attrs = this.model.attributes;
	var allocWait = attrs.sentAllocRequest && !attrs.num;
	var d = attrs.uploading || allocWait;
	var self = this;
	with_dom(function () {
		/* Beware of undefined! */
		self.submit.prop('disabled', !!d);
		if (attrs.uploaded)
			self.submit.css({'margin-left': '0'});
		self.$cancel.prop('disabled', !!allocWait);
		self.$cancel.toggle(!!(!attrs.num || attrs.uploading));
		self.$imageInput.prop('disabled', !!attrs.uploading);
		self.$uploadStatus.text(attrs.uploadStatus);
	});
},

prep_upload: function () {
	this.model.set('uploadStatus', UPLOADING_MSG);
	this.$input.focus();
	var attrs = this.model.attributes;
	return {spoiler: attrs.spoiler, op: attrs.op || 0};
},

notify_uploading: function () {
	this.model.set({uploading: true, cancelled: false});
	this.$input.focus();
},

make_upload_form: function () {
	var form = $('<form method="post" enctype="multipart/form-data" '
		+ 'target="upload"></form>');
	this.$cancel = $('<input>', {
		type: 'button', value: 'Cancel',
		click: $.proxy(this, 'cancel'),
	});
	var opts = {
		type: 'file', id: 'image', name: 'image',
		change: $.proxy(this, 'on_image_chosen'),
	};
	if (!imagerConfig.VIDEO)
		opts.accept = 'image/*';
	this.$imageInput = $('<input>', opts);
	this.$toggle = $('<input>', {
		type: 'button', id: 'toggle',
	});
	this.$uploadStatus = $('<strong/>');
	form.append(this.$cancel, this.$imageInput, this.$toggle, ' ',
			this.$uploadStatus);
	this.$iframe = $('<iframe></iframe>', {
		src: '', name: 'upload', id: 'hidden-upload',
	}).appendTo('body');
	if (nashi.upload) {
		this.$imageInput.hide();
		this.$toggle.hide();
	}
	this.model.set({spoiler: 0, nextSpoiler: -1});
	return form;
},

on_image_chosen: function () {
	if (this.model.get('uploading') || this.model.get('uploaded'))
		return;
	if (!this.$imageInput.val()) {
		this.model.set('uploadStatus', '');
		return;
	}
	var extra = this.prep_upload();
	for (var k in extra)
		$('<input type=hidden>').attr('name', k).val(extra[k]
				).appendTo(this.uploadForm);
	this.uploadForm.prop('action', image_upload_url());
	this.uploadForm.submit();
	this.$iframe.load(function (event) {
		if (!postForm)
			return;
		var doc = this.contentWindow || this.contentDocument;
		if (!doc)
			return;
		try {
			var error = $(doc.document || doc).text();
			// if it's a real response, it'll postMessage to us,
			// so we don't have to do anything.
			if (/legitimate imager response/.test(error))
				return;
			// sanity check for weird browser responses
			if (error.length < 5 || error.length > 100)
				error = 'Unknown upload error.';
			postForm.upload_error(error);
		}
		catch (e) {
			// likely cross-origin restriction
			// wait before erroring in case the message shows up
			setTimeout(function () {
				postForm.upload_finished_fallback();
			}, 500);
		}
	});
	this.notify_uploading();
},

on_toggle: function (event) {
	var attrs = this.model.attributes;
	if (!attrs.uploading && !attrs.uploaded) {
		event.preventDefault();
		event.stopImmediatePropagation();
		if (attrs.spoiler) {
			this.model.set({spoiler: 0});
			return;
		}
		var pick = pick_spoiler(attrs.nextSpoiler);
		this.model.set({spoiler: pick.index, nextSpoiler: pick.next});
	}
},

render_spoiler_pane: function (model, sp) {
	var img = sp ? spoiler_pane_url(sp) : mediaURL + 'css/ui/pane.png';
	this.$toggle.css('background-image', 'url("' + img + '")');
},

});

function image_upload_url() {
	var url = imagerConfig.UPLOAD_URL || '../upload/';
	return url + '?id=' + CONN_ID
}

dispatcher[IMAGE_STATUS] = function (msg) {
	if (postForm)
		postForm.dispatch(msg[0]);
};

window.addEventListener('message', function (event) {
	var msg = event.data;
	if (msg == 'OK')
		return;
	else if (postForm)
		postForm.upload_error(msg);
}, false);

function spoiler_pane_url(sp) {
	return mediaURL + 'kana/spoil' + sp + '.png';
}

function preload_panes() {
	var all = spoilerImages.normal.concat(spoilerImages.trans);
	for (var i = 0; i < all.length; i++)
		new Image().src = spoiler_pane_url(all[i]);
}

(function () {
	var CV = ComposerView.prototype;
	CV.finish_wrapped = _.wrap(CV.finish, with_dom);
})();
