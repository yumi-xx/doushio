var _ = require('../lib/underscore'),
    common = require('../common'),
    config = require('../config'),
    crypto = require('crypto'),
    formidable = require('formidable'),
    querystring = require('querystring'),
    RES = require('./state').resources,
    request = require('request'),
    winston = require('winston'),
    crypt = require('crypto'),
    mysql = require('mysql'),
    fs = require('fs');

function connect() {
	return global.redis;
}

// Logs in users who make a query ?username=USER&password=PASS
// Upgraded to use a SQL database
exports.login = function (req, resp) {
	var ip = req.ident.ip;
	var user = req.query.username;
	var password = req.query.password;
	var ip = req.ident.ip;
	var packet = {ip: ip, user: user, date: Date.now()};
	// Need to upgrade to POST sometime
	if (!user || !password) {
		resp.writeHead(302, {'Location':'/login.html'});
		resp.end('Redirecting to login page. . .');
		return;
	}
	var connection = mysql.createConnection({
	host     : 'localhost',
	user     : config.MYSQL_USER,
	password : config.MYSQL_PASS,
	database : config.MYSQL_DATABASE
	});
	// Initialize the SQL Database
	connection.connect();
	// Prepare and execute a SQL query
	// Results of the SQL query are put in rows[0] (assuming unique usernames)
	connection.query('SELECT password,is_admin,is_mod FROM ' + config.MYSQL_TABLE + ' WHERE username="' + user + '"', function(err,rows) {
		if (!err) {
			// Compare the gotten password with the hashed password in the MYSQL table
			var sha = crypto.createHash('sha512').update(password);
			var hashedPassword = sha.digest('hex');
			// Kick out unauthenticated users
			if (!rows[0] || hashedPassword != rows[0].password) {
				winston.error("Login attempt by @" + user + " from " + ip);
				return respond_error(resp, 'Invalid username or password');
			}
			// Log in administrators
			if (rows[0].is_admin == "y") {
				winston.info("@" + user + " logging in as admin from " + ip);
				packet.auth = 'Admin';
				exports.set_cookie(req, resp, packet);
			}
			// Log in moderators
			else if (rows[0].is_mod == "y") {
				winston.info("@" + user + " logging in as moderator from " + ip);
				packet.auth = 'Moderator';
				exports.set_cookie(req, resp, packet);
			}
		}
		else
			winston.warn("SQL database " + config.MYSQL_DATABASE + "is not accessible");
			return respond_error(resp, 'Could not access the database, please yell at the systems administrator!');
	});
	connection.end();
}

exports.set_cookie = function (req, resp, info) {
	var pass = random_str();
	info.csrf = random_str();

	var m = connect().multi();
	m.hmset('session:'+pass, info);
	m.expire('session:'+pass, config.LOGIN_SESSION_TIME);
	m.exec(function (err) {
		if (err)
			return oauth_error(resp, err);
		respond_ok(req, resp, make_cookie('a', pass, info.expires));
	});
};

function extract_login_cookie(chunks) {
	if (!chunks || !chunks.a)
		return false;
	return /^[a-zA-Z0-9+\/]{20}$/.test(chunks.a) ? chunks.a : false;
}
exports.extract_login_cookie = extract_login_cookie;

exports.check_cookie = function (cookie, callback) {
	var r = connect();
	r.hgetall('session:' + cookie, function (err, session) {
		if (err)
			return callback(err);
		else if (_.isEmpty(session))
			return callback('Not logged in.');
		callback(null, session);
	});
};

exports.logout = function (req, resp) {
	if (req.method != 'POST') {
		resp.writeHead(302, {'Location':'/logout.html'});
		resp.end('Redirecting to logout page. . .');
		return;
	}
	var r = connect();
	var cookie = extract_login_cookie(req.cookies);
	if (!cookie) {
		console.log('no cookie');
		return respond_error(resp, "No login cookie for logout.");
	}
	r.hgetall('session:' + cookie, function (err, session) {
		if (err)
			return respond_error(resp, "Logout error.");
		r.del('session:' + cookie);
		respond_ok(req, resp, 'a=; expires=Thu, 01 Jan 1970 00:00:00 GMT');
	});
};

function respond_error(resp, message) {
	resp.writeHead(200, {'Content-Type': 'application/json'});
	resp.end(JSON.stringify({status: 'error', message: message}));
}

function respond_ok(req, resp, cookie) {
	var headers = {'Set-Cookie': cookie};
	if (/json/.test(req.headers.accept)) {
		headers['Content-Type'] = 'application/json';
		resp.writeHead(200, headers);
		resp.end(JSON.stringify({status: 'okay'}));
	}
	else if (req.popup_HACK) {
		headers['Content-Type'] = 'text/html';
		resp.writeHead(200, headers);
		resp.end('<!doctype html><title>OK</title>Logged in!' +
			'<script>window.opener.location.reload(); window.close();</script>');
	}
	else {
		headers.Location = config.DEFAULT_BOARD + '/';
		resp.writeHead(303, headers);
		resp.end("OK! Redirecting.");
	}
}

function make_expiry() {
	var expiry = new Date(Date.now()
		+ config.LOGIN_SESSION_TIME*1000).toUTCString();
	/* Change it to the expected dash-separated format */
	var m = expiry.match(/^(\w+,\s+\d+)\s+(\w+)\s+(\d+\s+[\d:]+\s+\w+)$/);
	return m ? m[1] + '-' + m[2] + '-' + m[3] : expiry;
}

function make_cookie(key, val) {
	var header = key + '=' + val + '; Expires=' + make_expiry();
	var domain = config.LOGIN_COOKIE_DOMAIN;
	if (domain)
		header += '; Domain=' + domain;
	return header;
}

function random_str() {
	return crypto.randomBytes(15).toString('base64');
}
