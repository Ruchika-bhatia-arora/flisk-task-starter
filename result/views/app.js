var app = angular.module('catsvsdogs', []);
// The page is served under a path prefix (/api/result/), so the socket must connect under it too.
var socket = io.connect(window.location.origin, {
  path: window.location.pathname.replace(/\/$/, '') + '/socket.io'
});

var bg1 = document.getElementById('background-stats-1');
var bg2 = document.getElementById('background-stats-2');

app.controller('statsCtrl', function($scope){
  $scope.aPercent = 50;
  $scope.bPercent = 50;
  $scope.labels = { a: '', b: '' };

  // Option labels come from the results service (same OPTION_A/OPTION_B as the vote page).
  // Served under the same path prefix as the page, so build the URL from the current location.
  fetch(window.location.pathname.replace(/\/$/, '') + '/options')
    .then(function (res) { return res.json(); })
    .then(function (opts) {
      $scope.$apply(function () {
        $scope.labels.a = opts.a;
        $scope.labels.b = opts.b;
      });
    });

  var updateScores = function(){
    socket.on('scores', function (json) {
       data = JSON.parse(json);
       var a = parseInt(data.a || 0);
       var b = parseInt(data.b || 0);

       var percentages = getPercentages(a, b);

       bg1.style.width = percentages.a + "%";
       bg2.style.width = percentages.b + "%";

       $scope.$apply(function () {
         $scope.aPercent = percentages.a;
         $scope.bPercent = percentages.b;
         $scope.total = a + b;
       });
    });
  };

  var init = function(){
    document.body.style.opacity=1;
    updateScores();
  };
  socket.on('message',function(data){
    init();
  });
});

function getPercentages(a, b) {
  var result = {};

  if (a + b > 0) {
    result.a = Math.round(a / (a + b) * 100);
    result.b = 100 - result.a;
  } else {
    result.a = result.b = 50;
  }

  return result;
}