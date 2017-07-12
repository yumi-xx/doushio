var _ = require('../lib/underscore'),
    auth = require('./auth'),
    caps = require('./caps'),
    config = require('../config'),
    formidable = require('formidable'),
    fs = require('fs'),
    hooks = require('../hooks'),
    Stream = require('stream'),
    url_parse = require('url').parse,
    util = require('util'),
    winston = require('winston');

var send;
if (config.SERVE_STATIC_FILES)
	send = require('send');

var escape = require('../common').escape_html;
var routes = [];
var resources = [];

var server;
if (config.USE_HTTPS) {
	var credentials = {key: fs.readFileSync('certs/howler.key'),
		cert: fs.readFileSync('certs/howler.crt')};
	server = require('tls').createServer(credentials, function (s) {
		s.write('HTTPS not yet implemented');
		s.pipe(s);
	});
}
else {
	server = require('http').createServer(receive_request);
}

function receive_request(req, resp) {
	var ip = req.connection.remoteAddress;
	if (config.TRUST_X_FORWARDED_FOR)
		ip = parse_forwarded_for(req.headers['x-forwarded-for']) || ip;
	if (!ip) {
		resp.writeHead(500, {'Content-Type': 'text/plain'});
		resp.end("Your IP could not be determined. "
				+ "This server is misconfigured.");
		return;
	}
	req.ident = caps.lookup_ident(ip);
	if (req.ident.timeout)
		return timeout(resp);
	if (req.ident.ban)
		return render_500(resp);
	if (req.ident.slow)
		return slow_request(req, resp);
	handle_request(req, resp);
}
exports.server = server;
function handle_request(req, resp) {
	var method = req.method.toLowerCase();
	var parsed = url_parse(req.url, true);
	req.url = parsed.pathname;
	req.query = parsed.query;
	req.cookies = parse_cookie(req.headers.cookie);

	var numRoutes = routes.length;
	for (var i = 0; i < numRoutes; i++) {
		var route = routes[i];
		if (method != route.method)
			continue;
		var m = req.url.match(route.pattern);
		if (m) {
			route.handler(req, resp, m);
			if (config.DEBUG)
				winston.verbose(route.method.toUpperCase() + ' ' + req.url);
			return;
		}
	}

	if (method == 'get' || method == 'head')
		for (var i = 0; i < resources.length; i++)
			if (handle_resource(req, resp, resources[i]))
				return;

	if (config.SERVE_IMAGES) {
		if (require('../imager').serve_image(req, resp))
			return;
	}

	if (config.SERVE_STATIC_FILES) {
		send(req, req.url, {root: 'www/'}).pipe(resp);
		return;
	}
	render_404(resp);
	if (config.DEBUG)
		winston.verbose('404 ' + req.url + ' fallthrough');
}

function handle_resource(req, resp, resource) {
	var m = req.url.match(resource.pattern);
	if (!m)
		return false;
	var args = [req];
	if (resource.headParams)
		args.push(m);
	args.push(resource_second_handler.bind(null, req, resp, resource));

	var cookie = auth.extract_login_cookie(req.cookies);
	if (cookie) {
		auth.check_cookie(cookie, function (err, ident) {
			if (err && !resource.authPassthrough) {
				if (config.DEBUG)
					winston.verbose('DENY ' + req.url + ' ('  + err + ')');
				return forbidden(resp, 'No cookie.');
			}
			else if (!err)
				_.extend(req.ident, ident);
			resource.head.apply(null, args);
		});
	}
	else if (!resource.authPassthrough) {
		if (config.DEBUG)
			winston.verbose('DENY ' + req.url);
		render_404(resp);
	}
	else
		resource.head.apply(null, args);
	return true;
}

function resource_second_handler(req, resp, resource, err, act, arg) {
	var method = req.method.toLowerCase();
	var log = config.DEBUG;
	if (err) {
		if (err == 404) {
			if (log)
				winston.verbose('404 ' + req.url);
			return render_404(resp);
		}
		else if (err != 500)
			winston.error(err);
		else if (log)
			winston.verbose('500 ' + req.url);
		return render_500(resp);
	}
	else if (act == 'ok') {
		if (log)
			winston.verbose(method.toUpperCase() + ' ' + req.url + ' 200');
		if (method == 'head') {
			var headers = (arg && arg.headers) || vanillaHeaders;
			resp.writeHead(200, headers);
			resp.end();
			if (resource.tear_down)
				resource.tear_down.call(arg);
		}
		else {
			if (resource.tear_down) {
				if (!arg)
					arg = {};
				arg.finished = function () {
					resource.tear_down.call(arg);
				};
			}
			resource.get.call(arg, req, resp);
		}
	}
	else if (act == 304) {
		resp.writeHead(304);
		resp.end();
		if (log)
			winston.verbose('304 ' + req.url);
	}
	else if (act == 'redirect' || (act >= 300 && act < 400)) {
		var headers = {Location: arg};
		if (act == 'redirect')
			act = 303;
		if (log)
			winston.verbose(act + ' ' + req.url + ' to ' + arg);
		if (act == 303.1) {
			act = 303;
			headers['X-Robots-Tag'] = 'nofollow';
		}
		resp.writeHead(act, headers);
		resp.end();
	}
	else if (act == 'redirect_js') {
		if (log)
			winston.verbose('303.js ' + req.url + ' to ' + arg);
		if (method == 'head') {
			resp.writeHead(303, {Location: arg});
			resp.end();
		}
		else
			redirect_js(resp, arg);
	}
	else
		throw new Error("Unknown resource handler: " + act);
}

exports.route_get = function (pattern, handler) {
	routes.push({method: 'get', pattern: pattern,
			handler: auth_passthrough.bind(null, handler)});
};

exports.resource = function (pattern, head, get, tear_down) {
	if (head === true)
		head = function (req, cb) { cb(null, 'ok'); };
	var res = {pattern: pattern, head: head, authPassthrough: true};
	res.headParams = (head.length == 3);
	if (get)
		res.get = get;
	if (tear_down)
		res.tear_down = tear_down;
	resources.push(res);
};

exports.resource_auth = function (pattern, head, get, finished) {
	if (head === true)
		head = function (req, cb) { cb(null, 'ok'); };
	var res = {pattern: pattern, head: head, authPassthrough: false};
	res.headParams = (head.length == 3);
	if (get)
		res.get = get;
	if (finished)
		res.finished = finished;
	resources.push(res);
};

function parse_forwarded_for(ff) {
	if (!ff)
		return null;
	var ips = ff.split(',');
	if (!ips.length)
		return null;
	var last = ips[ips.length - 1].trim();
	/* check that it looks like some kind of IPv4/v6 address */
	if (!/^[\da-fA-F.:]{3,45}$/.test(last))
		return null;
	return last;
}
exports.parse_forwarded_for = parse_forwarded_for;

function auth_passthrough(handler, req, resp, params) {
	var cookie = auth.extract_login_cookie(req.cookies);
	if (!cookie) {
		handler(req, resp, params);
		return;
	}

	auth.check_cookie(cookie, function (err, ident) {
		if (!err)
			_.extend(req.ident, ident);
		handler(req, resp, params);
	});
}

exports.route_get_auth = function (pattern, handler) {
	routes.push({method: 'get', pattern: pattern,
			handler: auth_checker.bind(null, handler, false)});
};

function auth_checker(handler, is_post, req, resp, params) {
	if (is_post) {
		var form = new formidable.IncomingForm();
		form.maxFieldsSize = 50 * 1024;
		form.type = 'urlencoded';
		try {
			form.parse(req, function (err, fields) {
				if (err) {
					resp.writeHead(500, noCacheHeaders);
					resp.end(preamble + escape(err));
					return;
				}
				req.body = fields;
				check_it();
			});
		}
		catch (e) {
			winston.error('formidable threw: ' + e);
			return forbidden(resp, 'Bad request.');
		}
	}
	else
		check_it();

	function check_it() {
		cookie = auth.extract_login_cookie(req.cookies);
		if (!cookie)
			return forbidden(resp, 'No cookie.');
		auth.check_cookie(cookie, ack);
	}

	function ack(err, session) {
		if (err)
			return forbidden(resp, err);
		if (is_post && session.csrf != req.body.csrf)
			return forbidden(resp, "Possible CSRF.");
		_.extend(req.ident, session);
		handler(req, resp, params);
	}
}

function forbidden(resp, err) {
	resp.writeHead(401, noCacheHeaders);
	resp.end(preamble + escape(err));
}

exports.route_post = function (pattern, handler) {
	// auth_passthrough conflicts with formidable
	// (by the time the cookie check comes back, formidable can't
	// catch the form data)
	// We don't need the auth here anyway currently thanks to client_id
	routes.push({method: 'post', pattern: pattern, handler: handler});
};

exports.route_post_auth = function (pattern, handler) {
	routes.push({method: 'post', pattern: pattern,
			handler: auth_checker.bind(null, handler, true)});
};

var vanillaHeaders = {
	'Content-Type': 'text/html; charset=UTF-8',
	'X-Frame-Options': 'sameorigin',
};
var noCacheHeaders = {'Content-Type': 'text/html; charset=UTF-8',
		'Expires': 'Thu, 01 Jan 1970 00:00:00 GMT',
		'Cache-Control': 'no-cache, no-store',
		'X-Frame-Options': 'sameorigin',
};
var preamble = '<!doctype html><meta charset=utf-8>';

exports.vanillaHeaders = vanillaHeaders;
exports.noCacheHeaders = noCacheHeaders;

exports.notFoundHtml = preamble + '<title>404</title>404';
exports.serverErrorHtml = preamble + '<title>500</title>Server error';

hooks.hook('reloadResources', function (res, cb) {
	exports.ncsuHtml = res.ncsuHtml;
	exports.notFoundTmpl = res.notFoundTmpl;
	exports.serverErrorHtml = res.serverErrorHtml;
	exports.rulesTmpl = res.rulesTmpl;
	cb(null);
});

function render_404(resp) {
/* Apache intercepts our 404 instead of rendering our custom page
 * So just throw a 200 for now. . .
 */
	resp.writeHead(200, noCacheHeaders);
	resp.end(exports.notFoundTmpl[0]);
};
exports.render_404 = render_404;

function render_500(resp) {
	resp.writeHead(500, noCacheHeaders);
	resp.end(exports.serverErrorHtml);
}
exports.render_500 = render_500;

function render_rules(req, resp) {
	resp.writeHead(200);
	resp.end(exports.rulesTmpl[0]);
};
exports.render_rules = render_rules;

function slow_request(req, resp) {
	var n = Math.floor(1000 + Math.random() * 500);
	if (Math.random() < 0.1)
		n *= 10;
	setTimeout(function () {
		if (resp.finished)
			return;
		if (resp.socket && resp.socket.destroyed)
			return resp.end();
		handle_request(req, new Debuff(resp));
	}, n);
}

function timeout(resp) {
	var n = Math.random();
	n = Math.round(9000 + n*n*50000);
	setTimeout(function () {
		if (resp.socket && !resp.socket.destroyed)
			resp.socket.destroy();
		resp.end();
	}, n);
}

function redirect(resp, uri, code) {
	var headers = {Location: uri};
	for (var k in vanillaHeaders)
		headers[k] = vanillaHeaders[k];
	resp.writeHead(code || 303, headers);
	resp.end(preamble + '<title>Redirect</title>'
		+ '<a href="' + encodeURI(uri) + '">Proceed</a>.');
}
exports.redirect = redirect;

var redirectJsTmpl = require('fs').readFileSync('tmpl/redirect.html');

function redirect_js(resp, uri) {
	resp.writeHead(200, noCacheHeaders);
	resp.write(preamble + '<title>Redirecting...</title>');
	resp.write('<script>var dest = "' + encodeURI(uri) + '";</script>');
	resp.end(redirectJsTmpl);
}
exports.redirect_js = redirect_js;

exports.dump_server_error = function (resp, err) {
	resp.writeHead(500, noCacheHeaders);
	resp.write(preamble + '<title>Server error</title>\n<pre>');
	resp.write(escape(util.inspect(err)));
	resp.end('</pre>');
};

function parse_cookie(header) {
	var chunks = {};
	(header || '').split(';').forEach(function (part) {
		var bits = part.match(/^([^=]*)=(.*)$/);
		if (bits)
			try {
				chunks[bits[1].trim()] = decodeURIComponent(
						bits[2].trim());
			}
			catch (e) {}
	});
	return chunks;
}
exports.parse_cookie = parse_cookie;

exports.prefers_json = function (accept) {
	/* Not technically correct but whatever */
	var mimes = (accept || '').split(',');
	for (var i = 0; i < mimes.length; i++) {
		if (/json/i.test(mimes[i]))
			return true;
		else if (/(html|xml|plain|image)/i.test(mimes[i]))
			return false;
	}
	return false;
};

function Debuff(stream) {
	Stream.call(this);
	this.out = stream;
	this.buf = [];
	this.timer = 0;
	this.writable = true;
	this.destroyed = false;
	this.closing = false;
	this._flush = this._flush.bind(this);
	this.on_close = this.destroy.bind(this);
	this.on_error = this.on_error.bind(this);
	stream.once('close', this.on_close);
	stream.on('error', this.on_error);
	this.timeout = setTimeout(this.destroy.bind(this), 120*1000);
}
util.inherits(Debuff, Stream);

var D = Debuff.prototype;

D.writeHead = function () {
	if (!this._check())
		return false;
	this.buf.push({_head: [].slice.call(arguments)});
	this._queue();
	return true;
};

D.write = function (data, encoding) {
	if (!this._check())
		return false;
	if (encoding)
		this.buf.push({_enc: encoding, _data: data});
	else
		this.buf.push(data);
	this._queue();
	return true;
};

D.end = function (data, encoding) {
	if (!this._check())
		return;
	if (encoding)
		this.buf.push({_enc: encoding, _data: data});
	else if (data)
		this.buf.push(data);
	this._queue();
	this.closing = true;
	this.cleanEnd = true;
};

D._check = function () {
	if (!this.writable)
		return false;
	if (!this.out.writable) {
		this.destroy();
		return false;
	}
	if (this.out.sock && this.out.sock.destroyed) {
		this.destroy();
		return false;
	}
	return true;
};

D._queue = function () {
	if (this.timer)
		return;
	if (Math.random() < 0.05)
		return;
	var wait = 500 + Math.floor(Math.random() * 5000);
	if (Math.random() < 0.5)
		wait *= 2;
	this.timer = setTimeout(this._flush, wait);
};

D._flush = function () {
	var limit = 500 + Math.floor(Math.random() * 1000);
	if (Math.random() < 0.05)
		limit *= 3;

	var count = 0;
	while (this.out.writable && this.buf.length && count < limit) {
		var o = this.buf.shift();
		if (o._head) {
			this.out.writeHead.apply(this.out, o._head);
			this.statusCode = this.out.statusCode;
			continue;
		}
		var enc;
		if (o._enc && o._data) {
			enc = o.enc;
			o = o._data;
		}
		if (!o.length)
			continue;
		var n = limit - count;
		if (typeof o == 'string' && o.length > n) {
			this.buf.unshift(o.slice(n));
			o = o.slice(0, n);
		}
		count += o.length;
		if (!this.out.write(o, enc))
			break;
	}
	this.timer = 0;
	if (this.out.writable && this.buf.length)
		this._queue();
	else if (this.closing) {
		if (this.cleanEnd) {
			this.out.end();
			this._clean_up();
			this.emit('close');
		}
		else {
			this.destroy();
		}
	}
	else
		this.emit('drain');
};

D.destroy = function () {
	if (this.destroyed)
		return;
	this._clean_up();
	this.cleanEnd = false;
	this.emit('close');
};

D.destroySoon = function () {
	if (!this.timer)
		return this.destroy();
	this.writable = false;
	this.closing = true;
};

D.on_error = function (err) {
	if (!this.destroyed)
		this._clean_up();
	this.cleanEnd = false;
	this.emit('error', err);
};

D._clean_up = function () {
	this.writable = false;
	this.destroyed = true;
	this.closing = false;
	this.out.removeListener('close', this.on_close);
	this.out.removeListener('error', this.on_error);
	if (this.timer) {
		clearTimeout(this.timer);
		this.timer = 0;
	}
	if (this.timeout) {
		clearTimeout(this.timeout);
		this.timeout = 0;
	}
	if (!this.out.finished) {
		this.out.destroy();
	}
};

D.getHeader = function (name) { return this.out.getHeader(name); };
D.setHeader = function (k, v) { this.out.setHeader(k, v); };
D.removeHeader = function (name) { return this.out.removeHeader(name); };
D.addTrailers = function (headers) { this.out.addTrailers(headers); };
