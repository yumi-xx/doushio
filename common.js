var config = require('./config');
var imagerConfig = require('./imager/config');
var DEFINES = exports;
DEFINES.INVALID = 0;

DEFINES.INSERT_POST = 2;
DEFINES.UPDATE_POST = 3;
DEFINES.FINISH_POST = 4;
DEFINES.CATCH_UP = 5;
DEFINES.INSERT_IMAGE = 6;
DEFINES.SPOILER_IMAGES = 7;
DEFINES.DELETE_IMAGES = 8;
DEFINES.DELETE_POSTS = 9;
DEFINES.DELETE_THREAD = 10;
DEFINES.LOCK_THREAD = 11;
DEFINES.UNLOCK_THREAD = 12;
DEFINES.REPORT_POST = 13;
DEFINES.BAN_POST = 14;

DEFINES.PING = 30;
DEFINES.IMAGE_STATUS = 31;
DEFINES.SYNCHRONIZE = 32;
DEFINES.EXECUTE_JS = 33;
DEFINES.MOVE_THREAD = 34;
DEFINES.UPDATE_BANNER = 35;
DEFINES.TEARDOWN = 36;

DEFINES.MODEL_SET = 50;
DEFINES.COLLECTION_RESET = 55;
DEFINES.COLLECTION_ADD = 56;
DEFINES.SUBSCRIBE = 60;
DEFINES.UNSUBSCRIBE = 61;

DEFINES.ANON = 'Anonymous';
DEFINES.INPUT_ROOM = 20;
DEFINES.MAX_POST_LINES = 30;
DEFINES.MAX_POST_CHARS = 2000;
DEFINES.WORD_LENGTH_LIMIT = 120;

/// OneeSama.state[0] flags
DEFINES.S_NORMAL = 0;
DEFINES.S_BOL = 1;
DEFINES.S_QUOTE = 2;
DEFINES.S_SPOIL = 3;

if (typeof mediaURL == 'undefined' || !mediaURL)
	mediaURL = imagerConfig.MEDIA_URL;

function is_pubsub(t) {
	return t > 0 && t < 30;
}
exports.is_pubsub = is_pubsub;

function FSM(start) {
	this.state = start;
	this.spec = {acts: {}, ons: {}, wilds: {}, preflights: {}};
}
exports.FSM = FSM;

FSM.prototype.clone = function () {
	var second = new FSM(this.state);
	second.spec = this.spec;
	return second;
};

// Handlers on arriving to a new state
FSM.prototype.on = function (key, f) {
	var ons = this.spec.ons[key];
	if (ons)
		ons.push(f);
	else
		this.spec.ons[key] = [f];
	return this;
};

// Sanity checks before attempting a transition
FSM.prototype.preflight = function (key, f) {
	var pres = this.spec.preflights[key];
	if (pres)
		pres.push(f);
	else
		this.spec.preflights[key] = [f];
};

// Specify transitions and an optional handler function
FSM.prototype.act = function (trans_spec, on_func) {
	var halves = trans_spec.split('->');
	if (halves.length != 2)
		throw new Error("Bad FSM spec: " + trans_spec);
	var parts = halves[0].split(',');
	var dest = halves[1].match(/^\s*(\w+)\s*$/)[1];
	var tok;
	for (var i = parts.length-1; i >= 0; i--) {
		var part = parts[i];
		var m = part.match(/^\s*(\*|\w+)\s*(?:\+\s*(\w+)\s*)?$/);
		if (!m)
			throw new Error("Bad FSM spec portion: " + part);
		if (m[2])
			tok = m[2];
		if (!tok)
			throw new Error("Tokenless FSM action: " + part);
		var src = m[1];
		if (src == '*')
			this.spec.wilds[tok] = dest;
		else {
			var acts = this.spec.acts[src];
			if (!acts)
				this.spec.acts[src] = acts = {};
			acts[tok] = dest;
		}
	}
	if (on_func)
		this.on(dest, on_func);
	return this;
};

FSM.prototype.feed = function (ev, param) {
	var spec = this.spec;
	var from = this.state, acts = spec.acts[from];
	var to = (acts && acts[ev]) || spec.wilds[ev];
	if (to && from != to) {
		var ps = spec.preflights[to];
		for (var i = 0; ps && i < ps.length; i++)
			if (!ps[i].call(this, param))
				return false;
		this.state = to;
		var fs = spec.ons[to];
		for (var i = 0; fs && i < fs.length; i++)
			fs[i].call(this, param);
	}
	return true;
};

FSM.prototype.feeder = function (ev) {
	var self = this;
	return function (param) {
		self.feed(ev, param);
	};
};

var entities = {'&' : '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'};
function escape_html(html) {
	return html.replace(/[&<>"]/g, function (c) {
		return entities[c];
	});
}
exports.escape_html = escape_html;

function escape_fragment(frag) {
	var t = typeof(frag);
	if (t == 'object' && frag && typeof(frag.safe) == 'string')
		return frag.safe;
	else if (t == 'string')
		return escape_html(frag);
	else if (t == 'number')
		return frag.toString();
	else
		return '???';
}
exports.escape_fragment = escape_fragment;

function flatten(frags) {
	var out = [];
	for (var i = 0; i < frags.length; i++) {
		var frag = frags[i];
		if (Array.isArray(frag))
			out = out.concat(flatten(frag));
		else
			out.push(escape_fragment(frag));
	}
	return out;
}
exports.flatten = flatten;

function safe(frag) {
	return {safe: frag};
}
exports.safe = safe;

function is_noko(email) {
	return email && email.indexOf('@') == -1 && /noko/i.test(email);
}
exports.is_noko = is_noko;
function is_sage(email) {
	return config.SAGE_ENABLED && email &&
			email.indexOf('@') == -1 && /sage/i.test(email);
}
exports.is_sage = is_sage;

var OneeSama = function (t) {
	this.tamashii = t;
	this.hooks = {};
};
exports.OneeSama = OneeSama;
var OS = OneeSama.prototype;

var break_re = new RegExp("(\\S{" + DEFINES.WORD_LENGTH_LIMIT + "})");
/* internal refs, embeds */
var ref_re = />>(\d+|>\/[a-z]+\/|>\/watch\?v=[\w-]{11}(?:#t=[\dhms]{1,9})?|>\/soundcloud\/[\w-]{1,40}\/[\w-]{1,80}|>\/@\w{1,15}\/\d{4,20}(?:\?s=\d+)?|>\/a\/\d{0,10})/g;
// Uncomment to remove searching for embedded links
// var ref_re = />>(\d+|>\/[a-z]+\/)/;

OS.hook = function (name, func) {
	var hs = this.hooks[name];
	if (!hs)
		this.hooks[name] = hs = [func];
	else if (hs.indexOf(func) < 0)
		hs.push(func);
};

OS.trigger = function (name, param) {
	var hs = this.hooks[name];
	if (hs)
		for (var i = 0; i < hs.length; i++)
			hs[i].call(this, param);
};

function override(obj, orig, upgrade) {
	var origFunc = obj[orig];
	obj[orig] = function () {
		var args = [].slice.apply(arguments);
		args.unshift(origFunc);
		return upgrade.apply(this, args);
	};
}

/// converts one >>ref to html
OS.red_string = function (ref) {
	var prefix = ref.slice(0, 3);
	var dest, linkClass;
	// Handle board references
	if (config.BOARDS.indexOf(ref.slice(2, ref.length-1)) >= 0) {
		var board = ref.slice(2, ref.length-1);
		this.tamashii(board);
		return;
	}
	// Pouting machine functionality, show off the rules page!
	else if (ref == '>/rules/' || ref == '>/ruuruus/') {
		dest = "/rules";
	}
	else if (ref == '>/coffee/') {
		dest = "/outbound/coffee";
	}
	else if (prefix == '>/w') {
		dest = 'https://www.youtube.com/' + ref.slice(2);
		linkClass = 'embed watch';
	}
	else if (prefix == '>/s') {
		dest = 'https://soundcloud.com/' + ref.slice(13);
		linkClass = 'embed soundcloud';
	}
	else if (prefix == '>/@') {
		var bits = ref.slice(3).split('/');
		dest = 'https://twitter.com/' + bits[0] + '/status/' + bits[1];
		linkClass = 'embed tweet';
	}
	// Handle post references
	else if (!isNaN(parseInt(ref, 10))) {
		this.tamashii(parseInt(ref, 10));
		return;
	}
	else {
		this.callback(safe('<a class="nope">&gt;&gt;' + ref
			+ '</a>'));
                        return;
	}
	this.callback(new_tab_link(encodeURI(dest), '>>' + ref, linkClass));
};

/// 3rd tokenization stage; breaks text into chunks and >>refs
OS.break_heart = function (frag) {
	if (frag.safe)
		return this.callback(frag);
	// break long words
	var bits = frag.split(break_re);

	for (var i = 0; i < bits.length; i++) {
		// anchor >>refs
		var morsels = bits[i].split(ref_re);
		for (var j = 0; j < morsels.length; j++) {
			var m = morsels[j];
			if (j % 2)
				this.red_string(m);
			else if (i % 2) {
				this.geimu(m);
				this.callback(safe('<wbr>'));
			}
			else
				this.geimu(m);
		}
	}
};

/// 2nd tokenization stage; as we transition our state[0] flag, emits html tags as necessary
OS.iku = function (token, to) {
	var state = this.state;
	if (state[0] == DEFINES.S_QUOTE && to != DEFINES.S_QUOTE)
		this.callback(safe('</em>'));
	switch (to) {
	case DEFINES.S_QUOTE:
		if (state[0] != DEFINES.S_QUOTE) {
			this.callback(safe('<em>'));
			state[0] = DEFINES.S_QUOTE;
		}
		this.break_heart(token);
		break;
	case DEFINES.S_SPOIL:
		if (token[1] == '/') {
			state[1]--;
			this.callback(safe('</del>'));
		}
		else {
			var del = {html: '<del>'};
			this.trigger('spoilerTag', del);
			this.callback(safe(del.html));
			state[1]++;
		}
		break;
	default:
		this.break_heart(token);
		break;
	}
	state[0] = to;
}

/// 1st tokenization stage, breaking up [spoiler]s, >quotes, and line breaks
OS.fragment = function (frag) {
	var chunks = frag.split(/(\[\/?spoiler\])/i);
	var state = this.state;
	// Change 'states' (spoiler, spoiler) according to elements of the post
	for (var i = 0; i < chunks.length; i++) {
		var chunk = chunks[i], q = (state[0] === DEFINES.S_QUOTE);
		if (i % 2) {
			var to = DEFINES.S_SPOIL;
			if (chunk[1] == '/' && state[1] < 1)
				to = q ? DEFINES.S_QUOTE : DEFINES.S_NORMAL;
			this.iku(chunk, to);
			continue;
		}
		lines = chunk.split(/(\n)/);
		for (var l = 0; l < lines.length; l++) {
			var line = lines[l];
			if (l % 2)
				this.iku(safe('<br>'), DEFINES.S_BOL);
			else if (state[0] === DEFINES.S_BOL && ((line[0]=='>' || line[0]=='\uff1e')) && line[1] != '>')
				this.iku(line, DEFINES.S_QUOTE);
			else if (line)
				this.iku(line, q ? DEFINES.S_QUOTE
						: DEFINES.S_NORMAL);
		}
	}
};

/// converts one post body to HTML
OS.karada = function (body) {
	var output = [];
	// state[0] = output mode
	// state[1] = number of spoiler tags we're inside
	this.state = [DEFINES.S_BOL, 0];
	this.callback = function (frag) { output.push(frag); }
	this.fragment(body);
	this.callback = null;
	if (this.state[0] == DEFINES.S_QUOTE)
		output.push(safe('</em>'));
	for (var i = 0; i < this.state[1]; i++)
		output.push(safe('</del>'));
	return output;
}

var dice_re = /(#flip|#8ball|#fortune|#\d{0,2}d\d{1,4}(?:[+-]\d{1,4})?)/i;
exports.dice_re = dice_re;

var EIGHT_BALL = [
	'Yes',
	'No',
	'Maybe',
	'Ara ara~',
	'Hazy, try again',
];

var FORTUNE = [
"A copy of the Technician will get stuck to your shoe",
"You will be blessed with a warm air vent on a cold day",
"You will get paint on you while walking through the Free Expression Tunnel",
"The next rainy day you will slip on the bricks",
"You will see cows in the near future",
"You will fail to do anything meaningful next time you go to the library",
"Watch out for bikes",
"Sit in the front. . . everyone in the back hates you!",
"It will take twenty minutes to cross the street",
"Wear camo, cowboy boots, and a Carhartt jacket tomorrow for good luck",
"Do not go to class on a cold day",
"A passing train will startle you",
"You will avoid getting a parking ticket soon",
"The gym is closed",
"The coffee machine will break soon",
"You will not notice how long it takes to walk to your class",
"A statue will frown at you tomorrow",
"Be careful around nuclear reactors",
"Atrium is closed on the weekends",
"You will barely catch a bus",
"Tomorrow you will develop a southern drawl for at least 20 minutes",
"Go to lecture",
];

	

function parse_dice(frag) {
	if (frag == '#flip')
		return {n: 1, faces: 2};
	if (frag == '#8ball')
		return {n: 1, faces: EIGHT_BALL.length};
	if (frag == '#fortune')
		return {n: 1, faces: FORTUNE.length};
	
	var m = frag.match(/^#(\d*)d(\d+)([+-]\d+)?$/i);
	if (!m)
		return false;
	var n = parseInt(m[1], 10) || 1, faces = parseInt(m[2], 10);
	if (n < 1 || n > 10 || faces < 2 || faces > 100)
		return false;
	var info = {n: n, faces: faces};
	if (m[3])
		info.bias = parseInt(m[3], 10);
	return info;
}
exports.parse_dice = parse_dice;

function readable_dice(bit, d) {
	if (bit == '#flip')
		return '#flip (' + (d[1] == 2) + ')';
	if (bit == '#8ball')
		return '#8ball (' + EIGHT_BALL[d[1] - 1] + ')';
	if (bit == "#fortune")
		return '#fortune (' + FORTUNE[d[1] - 1] + ')';
	var f = d[0], n = d.length, b = 0;
	if (d[n-1] && typeof d[n-1] == 'object') {
		b = d[n-1].bias;
		n--;
	}
	var r = d.slice(1, n);
	n = r.length;
	bit += ' (';
	var eq = n > 1 || b;
	if (eq)
		bit += r.join(', ');
	if (b)
		bit += (b < 0 ? ' - ' + (-b) : ' + ' + b);
	var sum = b;
	for (var j = 0; j < n; j++)
		sum += r[j];
	return bit + (eq ? ' = ' : '') + sum + ')';
}

/// 4th tokenization stage; populates dice rolls
OS.geimu = function (text) {
	if (!this.dice) {
		this.kinpira(text);
		return;
	}

	var bits = text.split(dice_re);
	for (var i = 0; i < bits.length; i++) {
		var bit = bits[i];
		if (!(i % 2) || !parse_dice(bit)) {
			this.kinpira(bit);
		}
		else if (this.queueRoll) {
			this.queueRoll(bit);
		}
		else if (!this.dice[0]) {
			this.kinpira(bit);
		}
		else {
			var d = this.dice.shift();
			this.callback(safe('<strong>'));
			this.strong = true; // for client DOM insertion
			this.callback(readable_dice(bit, d));
			this.strong = false;
			this.callback(safe('</strong>'));
		}
	}
};

/// 5th tokenization stage; parses ^s
OS.kinpira = function (text) {
	this.itameshi(text);
// This section will be deprecated with a math parser in future commits
/*	if (!/[＾^]/.test(text) || /^([＾^]_|:[＾^])/.test(text)) {
		this.itameshi(text);
		return;
	}

	}
	var bits = text.split(/[＾^]/);
	// remove trailing ^s
	while (bits.length && bits[bits.length-1] == '')
		bits.pop();

	var soup = safe('<sup>');
	this.sup_level = 0;
	for (var i = 0; i < bits.length; i++) {
		if (bits[i])
			this.itameshi(bits[i]);
		if (i + 1 < bits.length && i < 5) {
			// if there's more text, open a <sup>
			this.itameshi(soup);
			this.sup_level++;
		}
	}
	// close all the sups we opened
	var n = this.sup_level;
	this.sup_level = 0;
	soup = safe('</sup>');
	for (var i = 0; i < n; i++)
	this.itameshi(soup);
	this.itameshi(text);*/
};

/// 6th tokenization stage; parses individual *italic* *words*
OS.itameshi = function (text) {
	while (true) {
		var m = /(^| )\*([^ *]+)\*($| )/.exec(text);
		if (!m)
			break;
		if (m.index > 0) {
			var before = text.slice(0, m.index);
			LINKIFY ? this.linkify(before) : this.callback(before);
		}
		if (m[1])
			this.callback(m[1]);
		this.callback(safe('<i>' + escape_html(m[2]) + '</i>'));
		text = text.slice(m.index + m[0].length - m[3].length);
	}
	if (text)
		LINKIFY ? this.linkify(text) : this.callback(text);
};

// Convert text URLs to clickable links
// *Not* recommended. Use at your own risk.
var LINKIFY = false;

/// optional 7th tokenization stage
if (LINKIFY) { OS.linkify = function (text) {

	var bits = text.split(/(https?:\/\/[^\s"<>^]*[^\s"<>'.,!?:;^])/);
	for (var i = 0; i < bits.length; i++) {
		if (i % 2) {
			var e = escape_html(bits[i]);
			// open in new tab, and disavow target
			this.callback(safe('<a href="' + e +
					'" rel="nofollow" target="_blank">' +
					e + '</a>'));
		}
		else
			this.callback(bits[i]);
	}
}; }

function chibi(imgnm, src) {
	var name = '', ext = '';
	var m = imgnm.match(/^(.*)(\.\w{3,4})$/);
	if (m) {
		name = m[1];
		ext = m[2];
	}
	var bits = [safe('<a href="'), src, safe('" download="'), imgnm];
	if (name.length >= 38) {
		bits.push(safe('" title="'), imgnm);
		imgnm = [name.slice(0, 30), safe('(&hellip;)'), ext];
	}
	bits.push(safe('" rel="nofollow">'), imgnm, safe('</a>'));
	return bits;
}

OS.spoiler_info = function (index, toppu) {
	var large = toppu || this.thumbStyle == 'large';
	var hd = toppu || this.thumbStyle != 'small';
	return {
		thumb: encodeURI(mediaURL + 'spoilers/spoiler' + (hd ? '' : 's')
				+ index + '.png'),
		dims: large ? imagerConfig.THUMB_DIMENSIONS
				: imagerConfig.PINKY_DIMENSIONS,
	};
};

var spoilerImages = imagerConfig.SPOILER_IMAGES;

function pick_spoiler(metaIndex) {
	var imgs = spoilerImages;
	var n = imgs.normal.length;
	var count = n + imgs.trans.length;
	var i;
	if (metaIndex < 0)
		i = Math.floor(Math.random() * count);
	else
		i = metaIndex % count;
	var spoiler = i < n ? imgs.normal[i] : imgs.trans[i - n];
	return {index: spoiler, next: (i+1) % count};
}
exports.pick_spoiler = pick_spoiler;

function new_tab_link(srcEncoded, inside, cls) {
	return [safe('<a href="' + srcEncoded + '" target="_blank"' +
		(cls ? ' class="'+cls+'"' : '') +
		' rel="nofollow">'), inside, safe('</a>')];
}


OS.image_paths = function () {
	if (!this._imgPaths) {
		this._imgPaths = {
			src: mediaURL + 'src/',
			thumb: mediaURL + 'thumb/',
			mid: mediaURL + 'mid/',
			vint: mediaURL + 'vint/',
		};
		this.trigger('mediaPaths', this._imgPaths);
	}
	return this._imgPaths;
};

var audioIndicator = "\u266B"; // musical note

OS.gazou = function (info, toppu) {
	var src, name, caption, video;
	if (info.vint) {
		src = encodeURI('../outbound/hash/' + info.MD5);
		var google = encodeURI('../outbound/g/' + info.vint);
		var iqdb = encodeURI('../outbound/iqdb/' + info.vint);
		caption = ['Search ', new_tab_link(google, '[Google]'), ' ',
			new_tab_link(iqdb, '[iqdb]'), ' ',
			new_tab_link(src, '[foolz]')];
	}
	else {
		src = encodeURI(this.image_paths().src + info.src);
		video = info.video || (/\.webm$/i.test(src) && 'webm'); // webm check is legacy
		caption = [video ? 'Video ' : 'Image ', new_tab_link(src, info.src)];
	}

	var img = this.gazou_img(info, toppu);
	var dims = info.dims[0] + 'x' + info.dims[1];

	return [safe('<figure data-MD5="'), info.MD5,
		safe('" data-size="'), info.size,
		video ? [safe('" data-video="'), video] : '',
		safe('"><figcaption>'),
		caption, safe(' <i>('),
		info.audio ? (audioIndicator + ', ') : '',
		info.duration ? (info.duration + ', ') : '',
		readable_filesize(info.size), ', ',
		dims, (info.apng ? ', APNG' : ''),
		this.full ? [', ', chibi(info.imgnm, img.src)] : '',
		safe(')</i></figcaption>'),
		this.thumbStyle == 'hide' ? '' : img.html,
		safe('</figure>\n\t')];
};

exports.thumbStyles = ['small', 'sharp', 'large', 'hide'];

OS.gazou_img = function (info, toppu) {
	var src, thumb;
	var imgPaths = this.image_paths();
	if (!info.vint)
		src = thumb = encodeURI(imgPaths.src + info.src);

	var d = info.dims;
	var w = d[0], h = d[1], tw = d[2], th = d[3];
	if (info.spoiler) {
		var sp = this.spoiler_info(info.spoiler, toppu);
		thumb = sp.thumb;
		tw = sp.dims[0];
		th = sp.dims[1];
	}
	else if (info.vint) {
		tw = tw || w;
		th = th || h;
		src = encodeURI('../outbound/hash/' + info.MD5);
		thumb = imgPaths.vint + info.vint;
	}
	else if (this.thumbStyle != 'small' && info.mid) {
		thumb = encodeURI(imgPaths.mid + info.mid);
		if (!toppu && this.thumbStyle == 'large') {
			tw *= 2;
			th *= 2;
		}
	}
	else if (info.thumb)
		thumb = encodeURI(imgPaths.thumb + info.thumb);
	else {
		tw = w;
		th = h;
	}

	var img = '<img src="'+thumb+'"';
	if (tw && th)
		img += ' width="' +tw+'" height="'+th+'">';
	else
		img += '>';
	if (imagerConfig.IMAGE_HATS)
		img = '<span class="hat"></span>' + img;
	img = new_tab_link(src, safe(img));
	return {html: img, src: src};
};

function readable_filesize(size) {
	/* Dealt with it. */
	if (size < 1024)
		return size + ' B';
	if (size < 1048576)
		return Math.round(size / 1024) + ' KB';
	size = Math.round(size / 104857.6).toString();
	return size.slice(0, -1) + '.' + size.slice(-1) + ' MB';
}
exports.readable_filesize = readable_filesize;

function pad(n) {
	return (n < 10 ? '0' : '') + n;
}

OS.readable_time = function (time) {
	var h = this.tz_offset;
	var offset;
	if (h || h == 0)
		offset = h * 60 * 60 * 1000;
	else /* would be nice not to construct new Dates all the time */
		offset = new Date().getTimezoneOffset() * -60 * 1000;
	var d = new Date(time + offset);
	var k = [
		'Sun',
		'Mon',
		'Tue',
		'Wed',
		'Thu',
		'Fri',
		'Sat'
	][d.getUTCDay()];
	return (d.getUTCFullYear() + '/' + pad(d.getUTCMonth()+1) + '/' +
		pad(d.getUTCDate()) + '&nbsp;(' + k + ') ' +
		pad(d.getUTCHours()) + ':' +
		pad(d.getUTCMinutes()));
};

function datetime(time) {
	var d = new Date(time);
	return (d.getUTCFullYear() + '-' + pad(d.getUTCMonth()+1) + '-' +
		pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + ':' +
		pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + 'Z');
}

OS.post_url = function (num, op, quote) {
	op = op || num;
	return (this.op == op ? '' : op) + (quote ? '#q' : '#') + num;
};

OS.post_ref = function (num, op, desc_html) {
	var ref = '&gt;&gt;' + num;
	if (desc_html)
		ref += ' ' + desc_html;
	else if (this.op && this.op != op)
		ref += ' \u2192';
	else if (num == op && this.op == op)
		ref += ' (OP)';
	return safe('<a href="'+this.post_url(num, op, false)+'">'+ref+'</a>');
};
OS.board_ref = function (board, desc_html) {
	var ref = '>>>/' + board + '/';
	if (desc_html)
		ref += ' ' + desc_html;
	return safe('<a href="/' + board + '">'+ref+'</a>');
};

OS.post_nav = function (post) {
	var n = post.num, o = post.op;
	return safe('<nav><a href="' + this.post_url(n, o, false) +
			'">No.</a><a href="' + this.post_url(n, o, true) +
			'">' + n + '</a></nav>');
};

function action_link_html(href, name, id) {
	var span = '<span ' + (id ? 'id="'+id+'" ' : '') + 'class="act">';
	return span + '<a href="'+href+'">'+name+'</a></span>';
}
exports.action_link_html = action_link_html;

exports.reasonable_last_n = function (n) {
	return n >= 5 && n <= 500;
};

OS.last_n_html = function (num) {
	return action_link_html(num + '?last' + this.lastN,
			'Last&nbsp;' + this.lastN);
};

OS.expansion_links_html = function (num, omit) {
	var html = ' &nbsp; ' + action_link_html(num, 'Expand');
	if (omit > this.lastN)
		html += ' ' + this.last_n_html(num);
	return html;
};

OS.atama = function (data) {
	var auth = data.auth;
	var header = auth ? [safe('<b class="'),auth.toLowerCase(),safe('">')]
			: [safe('<b>')];
	if (data.subject)
		header.unshift(safe('<h3>「'), data.subject, safe('」</h3> '));
	if (data.name || !data.trip) {
		header.push(data.name || DEFINES.ANON);
		if (data.trip)
			header.push(' ');
	}
	if (data.trip)
		header.push(safe('<code>' + data.trip + '</code>'));
	if (auth)
		header.push(' ## ' + auth);
	this.trigger('headerName', {header: header, data: data});
	header.push(safe('</b>'));
	if (data.email) {
		header.unshift(safe('<a class="email" href="mailto:'
			+ encodeURI(data.email) + '" target="_blank">'));
		header.push(safe('</a>'));
	}
	header.push(safe(' <time datetime="' + datetime(data.time) +
			'">' + this.readable_time(data.time) + '</time> '),
			this.post_nav(data));
	if (!this.full && !data.op) {
		var ex = this.expansion_links_html(data.num, data.omit);
		header.push(safe(ex));
	}
	this.trigger('headerFinish', {header: header, data: data});
	header.unshift(safe('<header>'));
	header.push(safe('</header>\n\t'));
	return header;
};

OS.monogatari = function (data, toppu) {
	var tale = {header: this.atama(data)};
	this.dice = data.dice;
	var body = this.karada(data.body);
	tale.body = [safe('<blockquote>'), body, safe('</blockquote>')];
	if (data.num == MILLION) {
		tale.body.splice(1, 0, safe('<script>window.gravitas=true;</script>'));
	}
	if (data.image && !data.hideimg)
		tale.image = this.gazou(data.image, toppu);
	return tale;
};

var MILLION = 1000000;

function gravitas_body() {
	$('body').css({margin: 0});
}

OS.gravitas_style = function (idata, cssy) {
	var src = this.image_paths().src + idata.src;
	src = "url('" + encodeURI(src) + "')";
	return cssy ? ("background-image: " + src + ";") : src;
};

OS.mono = function (data) {
	var info = {
		data: data,
		classes: data.editing ? ['editing'] : [],
		style: ''
	};
	if (data.num == MILLION) {
		info.classes.push('gravitas');
		if (data.image)
			info.style = this.gravitas_style(data.image, true);
	}
	this.trigger('openArticle', info);
	var cls = info.classes.length && info.classes.join(' '),
	    o = safe('\t<article id="'+data.num+'"' +
			(cls ? ' class="'+cls+'"' : '') +
			(info.style ? ' style="'+info.style+'"' : '') +
			'>');
	if (data.was_banned)
		c = safe('<span id="banned">(USER WAS BANNED FOR THIS POST)</span></article>'),
		gen = this.monogatari(data, false);
	else {
	    c = safe('</article>\n'),
	    gen = this.monogatari(data, false);
	}
	return flatten([o, gen.header, gen.image || '', gen.body, c]).join('');
};

OS.monomono = function (data, cls) {
	if (data.locked)
		cls = cls ? cls+' locked' : 'locked';
	var style;
	if (data.num == MILLION) {
		cls = cls ? cls+' gravitas' : 'gravitas';
		if (data.image)
			style = this.gravitas_style(data.image, true);
	}
	var o = safe('<section id="' + data.num +
		(cls ? '" class="' + cls : '') +
		(style ? '" style="' + style : '') +
		'" data-sync="' + (data.hctr || 0) +
		(data.full ? '' : '" data-imgs="'+data.imgctr) + '">'),
	    c = safe('</section>\n'),
	    gen = this.monogatari(data, true);
	return flatten([o, gen.image || '', gen.header, gen.body, '\n', c]);
};

function pluralize(n, noun) {
	return n + ' ' + noun + (n == 1 ? '' : 's');
}
exports.pluralize = pluralize;

exports.abbrev_msg = function (omit, img_omit) {
	return omit + (omit==1 ? ' reply' : ' replies') + (img_omit
		? ' and ' + pluralize(img_omit, 'image')
		: '') + ' omitted.';
};

exports.parse_name = function (name) {
	var tripcode = '', secure = '';
	var hash = name.indexOf('#');
	if (hash >= 0) {
		tripcode = name.substr(hash+1);
		name = name.substr(0, hash);
		hash = tripcode.indexOf('#');
		if (hash >= 0) {
			secure = escape_html(tripcode.substr(hash+1));
			tripcode = tripcode.substr(0, hash);
		}
		tripcode = escape_html(tripcode);
	}
	name = name.trim().replace(config.EXCLUDE_REGEXP, '');
	return [name.substr(0, 100), tripcode.substr(0, 128),
			secure.substr(0, 128)];
};

function random_id() {
	return Math.floor(Math.random() * 1e16) + 1;
}
