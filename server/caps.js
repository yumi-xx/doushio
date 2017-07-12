var async = require('async'),
    authcommon = require('../admin/common'),
    check = require('./msgcheck').check,
    common = require('../common'),
    config = require('../config'),
    db = require('../db'),
    hooks = require('../hooks');

var RANGES = require('./state').dbCache.ranges;

function can_access_board(ident, board) {
	if (ident.ban || ident.suspension)
		return false;
	if (board == 'graveyard' && can_administrate(ident))
		return true;
	if (board == config.STAFF_BOARD && !can_moderate(ident))
		return false;
	if (!temporal_access_check(ident, board))
		return false;
	return db.is_board(board);
}
exports.can_access_board = can_access_board;

exports.can_access_thread = function (ident, op) {
	var tags = db.tags_of(op);
	if (!tags)
		return false;
	for (var i = 0; i < tags.length; i++)
		if (can_access_board(ident, tags[i]))
			return tags[i];
	return false;
};

function temporal_access_check(ident, board) {
	var info = {ident: ident, board: board, access: true};
	hooks.trigger_sync('temporalAccessCheck', info);
	return info.access;
}
exports.temporal_access_check = temporal_access_check;

exports.can_ever_access_board = function (ident, board) {
	if (can_access_board(ident, board))
		return true;
	if (!temporal_access_check(ident, board))
		return true;
	return false;
};

function can_moderate(ident) {
	return (ident.auth === 'Admin' || ident.auth === 'Moderator');
}
exports.can_moderate = can_moderate;

function can_administrate(ident) {
	return ident.auth === 'Admin';
}
exports.can_administrate = can_administrate;

function denote_priv(info) {
	if (info.data.priv)
		info.header.push(' (priv)');
}

function dead_media_paths(paths) {
	paths.src = '../dead/src/';
	paths.thumb = '../dead/thumb/';
	paths.mid = '../dead/mid/';
}

exports.augment_oneesama = function (oneeSama, opts) {
	var ident = opts.ident;
	oneeSama.ident = ident;
	if (can_moderate(ident))
		oneeSama.hook('headerName', authcommon.append_mnemonic);
	if (can_administrate(ident)) {
		oneeSama.hook('headerName', denote_priv);
		oneeSama.hook('headerName', authcommon.denote_hidden);
	}
	if (can_administrate(ident) && opts.board == 'graveyard')
		oneeSama.hook('mediaPaths', dead_media_paths);
};

exports.mod_handler = function (func) {
	return function (nums, client) {
		if (!can_moderate(client.ident))
			return false;
		var opts = nums.shift();
		if (!check({when: 'string'}, opts) || !check('id...', nums))
			return false;
		if (!(opts.when in authcommon.delayDurations))
			return false;
		var delay = authcommon.delayDurations[opts.when];
		if (!delay)
			func(nums, client);
		else
			setTimeout(func.bind(null, nums, client), delay*1000);
		return true;
	};
};

function parse_ip(ip) {
	var m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)(?:\/(\d+))?$/);
	if (!m)
		return false;
	// damn you signed int32s!
	var num = 0;
	for (var i = 4, shift = 1; i > 0; i--) {
		num += parseInt(m[i], 10) * shift;
		shift *= 256;
	}

	var info = {full: ip, num: num};
	if (m[5]) {
		var bits = parseInt(m[5], 10);
		if (bits > 0 && bits <= 32) {
			info.mask = 0x100000000 - Math.pow(2, 32 - bits);
			info.num &= info.mask;
		}
	}
	return info;
}

function parse_ranges(ranges) {
	if (!ranges)
		return [];
	ranges = ranges.map(function (o) {
		if (typeof o == 'object') {
			o.ip = parse_ip(o.ip);
			return o;
		}
		else
			return {ip: parse_ip(o)};
	});
	ranges.sort(function (a, b) { return a.ip.num - b.ip.num; });
	return ranges;
}

function range_lookup(ranges, num) {
	if (!ranges)
		return null;
	/* Ideally would have a tree lookup here or something */
	var result = null;
	for (var i = 0; i < ranges.length; i++) {
		var box = ranges[i].ip;
		/* sint32 issue here doesn't matter for realistic ranges */
		if ((box.mask ? (num & box.mask) : num) === box.num)
			result = ranges[i];
		/* don't break out of loop */
	}
	return result;
}

hooks.hook('reloadHot', function (hot, cb) {
	var r = global.redis;
	async.forEach(authcommon.suspensionKeys, function (key, cb) {
		global.redis.smembers('hot:' + key, function (err, ranges) {
			if (err)
				return cb(err);
			if (key == 'suspensions')
				ranges = parse_suspensions(ranges);
			var up = key.toUpperCase();
			hot[up] = (hot[up] || []).concat(ranges || []);
			RANGES[key] = parse_ranges(hot[up]);
			cb(null);
		});
	}, cb);
});

function parse_suspensions(suspensions) {
	if (!suspensions)
		return [];
	var parsed = [];
	suspensions.forEach(function (s) {
		try {
			parsed.push(JSON.parse(s));
		}
		catch (e) {
			winston.error("Bad suspension JSON: " + s);
		}
	});
	return parsed;
}

exports.lookup_ident = function (ip) {
	var ident = {ip: ip};
	var num = parse_ip(ip).num;
	var ban = range_lookup(RANGES.bans, num);
	if (ban) {
		ident.ban = ban.ip.full;
		return ident;
	}
	ban = range_lookup(RANGES.timeouts, num);
	if (ban) {
		ident.ban = ban.ip.full;
		ident.timeout = true;
		return ident;
	}
	var suspension = range_lookup(RANGES.suspensions, num);
	if (suspension) {
		ident.suspension = suspension;
		return ident;
	}

	var priv = range_lookup(RANGES.boxes, num);
	if (priv)
		ident.priv = priv.ip.full;

	var slow = range_lookup(RANGES.slows, num);
	if (slow)
		ident.slow = slow;

	return ident;
};


