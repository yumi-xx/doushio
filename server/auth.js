var _ = require('../lib/underscore'),
	common = require('../common'),
	config = require('../config'),
	crypto = require('crypto'),
	formidable = require('formidable'),
	querystring = require('querystring'),
	RES = require('./state').resources,
	request = require('request'),
	winston = require('winston'),
	mysql = require('mysql'),
	fs = require('fs'),
	// Soon for password hashing against /etc/passwd or a DB
	bcrypt = require('bcrypt-pbkdf');

function connect() {
	return global.redis;
}

// Logs in users who make a POST to the login page
// Upgraded to use a SQL database
exports.login = function (req, resp) {
	// Has the user made an auth attempt?
	if (req.method.toLowerCase() != 'post') {
		fs.readFile('tmpl/login.html', 'UTF-8', function (err, lines) {
			if (err) {
				return respond_error(resp, 'Login page is disappeared!');
			}
			resp.write(lines);
			resp.end();
		});
		return;
	}
	var form = new formidable.IncomingForm();
	form.parse(req, function(err, fields, files) {
		var ip = req.ident.ip;
		var user = fields.username;
		var password = fields.password;
		var ip = req.ident.ip;
		var packet = {ip: ip, user: user, date: Date.now()};
		// Construct a sql query to pull out user information
		var query = 'SELECT password,is_admin,is_mod FROM '
			+ config.MYSQL_TABLE + ' WHERE username="' + user + '"';

		var db = mysql.createConnection({
		host     : 'localhost',
		user     : config.MYSQL_USER,
		password : config.MYSQL_PASS,
		database : config.MYSQL_DATABASE
		});
		// Initialize the SQL Database
		db.connect();
		// Prepare and execute a SQL query
		// Results of the SQL query are put in rows[0] (assuming unique usernames)
		db.query(query, function(err,rows) {
			if (!err) {
				// Compare the gotten password with the hashed password in the MYSQL table
				// NEEDS revision to verify using node module bcrypt-pbkdf
				var sha = crypto.createHash('sha512').update(password);
				var hashedPassword = sha.digest('hex');
				// Kick out unauthenticated users
				if (!rows[0] || hashedPassword != rows[0].password) {
					winston.error("Login attempt by @" + user + " from " + ip);
					return respond_error(resp, 'Invalid username or password');
				}
				// Log in administrators
				if (rows[0].is_admin == "y") {
					winston.info(user + " logging in as admin from " + ip);
					packet.auth = 'Admin';
					exports.set_cookie(req, resp, packet);
				}
				// Log in moderators
				else if (rows[0].is_mod == "y") {
					winston.info(user + " logging in as moderator from " + ip);
					packet.auth = 'Moderator';
					exports.set_cookie(req, resp, packet);
				}
			}
			else {
				winston.warn("SQL database " + config.MYSQL_DATABASE + " is not accessible");
				return respond_error(resp, 'Could not access the database!');
			}
		});
		db.end();
	});
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
