(function () {

var BOARD = document.location.pathname.match(/\/(\w+)\/$/)[1];

var $title = $('<h2/>', {text: '/' + BOARD + '/ is not in session.'});
var $when = $('<span/>');
var $remain = $('<p>', {text: 'Open in '}).append($when).append('.');
var countdownInterval, ticks = 0;

function countdown() {
	var now = new Date();
	var diff = Math.floor((END - now.getTime()) / 1000);
	if (diff < 0.5) {
		$remain.text('/' + BOARD + '/ is now open.');
		clearInterval(countdownInterval);
		if (ticks > 3)
			setTimeout(function () {
				location.reload(true);
			}, 1500);
	}
	var hours = Math.floor(diff / 3600);
	var minutes = Math.floor(diff / 60) % 60;
	var seconds = diff % 60;
	$when.text(pad(hours) + ':' + pad(minutes) + ':' + pad(seconds));
	ticks++;
}

function pad(n) {
	return n < 10 ? '0' + n : '' + n;
}

if (END) {
	setTimeout(function () {
		countdown();
		countdownInterval = setInterval(countdown, 1000);
	}, 1010 - new Date().getMilliseconds());
	countdown();
}
else {
	$remain.hide();
}

$('#countdown').append($title, $remain);

/*$('#bgm')[0].addEventListener('ended', function () {
	this.currentTime = 6.02;
	this.play();
}, false);*/

})();
