Real-time imageboard.
MIT licensed.

This fork provides MySQL authentication becuase Github OAuth is an offense.
But so is node.js. The real magic happens at https://github.com/lalcmellkmal/doushio

Setup:

* Install dependencies listed below
* Sign up for reCAPTCHA
* Create a MySQL table with at least the rows username, password, is_mod and is_admin
* Fill out the Table with admin/mod credentials (password is a SHA512 hash)
* Copy config.js.example to config.js and configure
* Copy hot.js.example to hot.js and configure
* Copy imager/config.js.example to imager/config.js and configure
* Copy report/config.js.example to report/config.js and configure
* Run `npm install` to install npm deps and compile a few helpers
* Run `node builder.js` to run an auto-reloading development server

Production:

* Have your webserver serve www/ (or wherever you've moved src, thumb, etc.)
* Run `node server/server.js` for just the server
* config.DAEMON support is broken for now
* You can update client code & hot.js on-the-fly with `node server/kill.js`
* For nginx hosting/reverse proxying, refer to docs/nginx.conf.example
* For a sample init script, refer to docs/doushio.initscript.example

Dependencies:

* ImageMagick
* libpng
* node.js + npm
* redis
* ffmpeg 2.2+ if supporting WebM
* jhead and jpegtran optionally, for EXIF autorotation

Optional npm deps for various features:

* ~~daemon~~ (broken currently)
* icecast now-playing banners: node-expat
* [send](https://github.com/visionmedia/send) (if you want to serve static files directly from the node.js process; useful in debug mode also)

Standalone upkeep scripts:

* archive/daemon.js - moves old threads to the archive
* upkeep/backup.js - uploads rdb to S3
* upkeep/clean.js - deletes archived images
* upkeep/radio.js - icecast2 server integration
