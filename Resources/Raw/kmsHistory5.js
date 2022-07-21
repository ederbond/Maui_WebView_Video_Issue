// CONFIGURATION EXAMPLE
/*
  kmsHistory: {
    plugin: true, <- enable the plugin
    trackViewed: true, <- should track the VIEWED status
    playbackContext: 'Mediaspace', <- playback context
    playbackCompletePercent: '80', <- after watching 80% of a clip
    playbackCompleteSeconds: 10, <- 10 seconds before the end of a clip
    proxyUrl: '<proxy server url>', <- for example 'http://il-async-api1.dev.kaltura.com:8080/api_v3/'
    iframeHTML5Js: './kmsHistory.js' <- path to the plugin JS file
  }
*/
(function($, mw) {
    'use strict';

    mw.kalturaPluginWrapper(function() {
        mw.PluginManager.add('kmsHistory', mw.KBasePlugin.extend({
            defaultConfig: {
                trackViewed: false,
                playbackContext: '',
                proxyUrl: '',
                playbackCompletePercent: '100%',
                playbackCompleteSeconds: 0 // possible values: percents or seconds from end. eg. '80%' or '10'
            },

            STATUS_VIEWED: 'viewHistory.VIEWED',
            STATUS_PLAYBACK_STARTED: 'viewHistory.PLAYBACK_STARTED',
            STATUS_PLAYBACK_COMPLETE: 'viewHistory.PLAYBACK_COMPLETE',
            MAX_RETRIES: 5,

            setup: function setup() {
                //console.log ('setting up the plugin!');

                this._viewHistoryPromises = {};
                this._queues = {};
                this._retriesLeft = {};
                this.getPlaybackCompleteSeconds = $.proxy(memoize(this.getPlaybackCompleteSeconds), this);

                this.kClient = mw.kApiGetPartnerClient(this.embedPlayer.kwidgetid);

                var that = this;
                this.bind('playerReady', function() {
                    var entryId = that.embedPlayer.evaluate('{mediaProxy.entry.id}');
                    that.trackLastTimeReached = throttle(function(lastTimeReached, passedEntryId) {
                        that.doTrackLastTimeReached(passedEntryId || entryId, lastTimeReached);
                    }, 2000);

                    that._retriesLeft[entryId] = that.MAX_RETRIES;

                    var isImage = that.embedPlayer.isImageSource();
                    if (that.getConfig('trackViewed') && !isImage) {
                        that.getViewHistory(entryId)
                            .then(function(viewHistory) {
                                return (viewHistory &&
                                    viewHistory.extendedStatus &&
                                    viewHistory.extendedStatus !== that.STATUS_VIEWED) ?
                                    viewHistory :
                                    that.trackHistory(entryId, {
                                        extendedStatus: that.STATUS_VIEWED
                                    });
                            });
                    }

                    if (isImage) {
                        that.getViewHistory(entryId)
                            .then(function(viewHistory) {
                                that.trackHistory(entryId, {
                                    extendedStatus: that.STATUS_PLAYBACK_COMPLETE
                                });
                            });
                    }
                });

                this.bind('firstPlay', function() {
                    var entryId = that.embedPlayer.evaluate('{mediaProxy.entry.id}');
                    var isImage = that.embedPlayer.isImageSource();
                    var isLive = that.embedPlayer.isLive();
                    that.getViewHistory(entryId)
                        .then(function(viewHistory) {
                            if (isImage) {
                                return that.trackHistory(entryId, {
                                    extendedStatus: that.STATUS_PLAYBACK_COMPLETE
                                });
                            }

                            if (isLive) {
                                return that.trackHistory(entryId, {
                                    extendedStatus: that.STATUS_PLAYBACK_STARTED
                                });
                            }

                            return (viewHistory &&
                                (viewHistory.extendedStatus === that.STATUS_PLAYBACK_STARTED ||
                                    viewHistory.extendedStatus === that.STATUS_PLAYBACK_COMPLETE)) ?
                                viewHistory :
                                that.trackHistory(entryId, {
                                    extendedStatus: that.STATUS_PLAYBACK_STARTED
                                });
                        });
                });

                this.bind('monitorEvent', function() {
                    if (that.canTrack() && that.embedPlayer.currentState !== 'end') {
                        if (that.isPlaybackComplete()) {
                            that.trackPlaybackComplete(that.embedPlayer.currentTime);
                        } else {
                            that.trackLastTimeReached(that.embedPlayer.currentTime);
                        }
                    }
                });

                this.bind('ended', function() {
                    if (that.canTrack()) {
                        that.trackPlaybackComplete(that.embedPlayer.duration);
                    }
                });
            },

            canTrack: function canTrack() {
                return !this.embedPlayer.isLive() && !this.embedPlayer.isImageSource() && !this.embedPlayer.isInSequence();
            },

            trackPlaybackComplete: function trackPlaybackComplete(lastTimeReached) {
                var entryId = this.embedPlayer.evaluate('{mediaProxy.entry.id}');
                var that = this;
                this.getViewHistory(entryId)
                    .then(function(viewHistory) {
                        if (!viewHistory || viewHistory.extendedStatus !== that.STATUS_PLAYBACK_COMPLETE) {

                            that.log('playback complete');
                            that.trackHistory(entryId, {
                                extendedStatus: that.STATUS_PLAYBACK_COMPLETE,
                                lastTimeReached: lastTimeReached
                            });
                        }

                        that.trackLastTimeReached(lastTimeReached, entryId);
                    });
            },

            doTrackLastTimeReached: function doTrackLastTimeReached(entryId, lastTimeReached) {
                lastTimeReached = Math.round(lastTimeReached);
                var that = this;
                this.getViewHistory(entryId)
                    .then(function(viewHistory) {
                        return (viewHistory && viewHistory.lastTimeReached === lastTimeReached) ?
                            viewHistory :
                            that.trackHistory(entryId, {
                                lastTimeReached: lastTimeReached
                            }, entryId);
                    });
            },

            trackHistory: function trackHistory(entryId, userEntry) {
                entryId = entryId || this.embedPlayer.evaluate('{mediaProxy.entry.id}');
                var that = this;
                var callback = function() {
                    return that.setViewHistory(entryId, userEntry);
                };

                return (this._queues[entryId] = $.when(this._queues[entryId])
                    .then(function() {
                        that._retriesLeft[entryId] = that.MAX_RETRIES;
                        return callback();
                    }, function(error) {
                        if (that._retriesLeft[entryId] > 0) {
                            that._retriesLeft[entryId]--;
                            that._viewHistoryPromises[entryId] = null;
                            return callback();
                        }

                        return $.Deferred().reject(error);
                    }));
            },

            setViewHistory: function setViewHistory(entryId, userEntry) {
                var request = {
                    service: 'userEntry',
                    'userEntry:objectType': 'KalturaViewHistoryUserEntry',
                    'userEntry:playbackContext': this.getConfig('playbackContext') || '',
                    'userEntry:lastUpdateTime': 1
                };

                $.each(userEntry, function(key, value) {
                    request['userEntry:' + key] = value;
                });

                var that = this;
                return this.getViewHistory(entryId)
                    .then(function(viewHistory) {
                        var id = viewHistory && viewHistory.id;
                        if (!id) {
                            that._viewHistoryPromises[entryId] = null;
                            return that.getViewHistory(entryId);
                        }

                        return viewHistory;
                    })
                    .then(function(viewHistory) {
                        //console.log ('updating history!! in '+that.getConfig('playbackContext'));

                        var id = viewHistory && viewHistory.id;
                        return that.doRequest($.extend(id ? {
                            action: 'update',
                            id: id,
                            'userEntry:extendedStatus': viewHistory.extendedStatus
                        } : {
                                action: 'add',
                                'userEntry:entryId': entryId
                            }, request), $.extend({}, viewHistory, userEntry));
                    })
                    .then(function(viewHistory) {
                        that.log('set', entryId, viewHistory);
                        that._viewHistoryPromises[entryId] = $.when(viewHistory);
                        return viewHistory;
                    });
            },

            getViewHistory: function getViewHistory(entryId) {
                var that = this;
                return this._viewHistoryPromises[entryId] ||
                    (this._viewHistoryPromises[entryId] = this.doRequest({
                        service: 'userEntry',
                        action: 'list',
                        'filter:objectType': 'KalturaViewHistoryUserEntryFilter',
                        'filter:entryIdEqual': entryId
                    }).then(function(response) {
                        that.log('get', entryId, response.objects && response.objects[0]);
                        return response.objects && response.objects[0];
                    }));
            },

            getPlaybackCompleteSeconds: function(duration) {
                var percent = String(this.getConfig('playbackCompletePercent'));
                if (percent && percent[percent.length - 1] === '%') {
                    percent = percent.slice(0, -1);
                }

                percent = Math.min(Math.round(Math.abs(Number(percent))), 100) || 100;

                var seconds = Math.abs(Number(this.getConfig('playbackCompleteSeconds'))) || 0;
                var res = Math.max(seconds, percent === 100 ? 0 : (duration - duration * percent / 100));
                this.log('seconds to end', res);
                return res;
            },

            isPlaybackComplete: function isPlaybackComplete(currentTime, duration) {
                currentTime = typeof currentTime !== 'undefined' ? currentTime : this.embedPlayer.currentTime;
                duration = typeof duration !== 'undefined' ? duration : this.embedPlayer.duration;
                var seconds = this.getPlaybackCompleteSeconds(duration);
                return seconds && (duration - currentTime <= seconds);
            },

            doRequest: function doRequest(requestObj, optimisticResult) {
                var ks = this.embedPlayer.getFlashvars().ks;
                if (!ks || this.embedPlayer.getError()) {
                    return $.Deferred().reject();
                }

                var proxyUrl = this.getConfig('proxyUrl');
                if (proxyUrl &&
                    requestObj &&
                    requestObj.action === 'update') {
                    return $.ajax({
                        type: 'POST',
                        url: proxyUrl,
                        contentType: 'application/json',
                        data: JSON.stringify($.extend({
                            ks: ks
                        }, requestObj, {
                            service: requestObj.service.toLowerCase()
                        }))
                    }).then(function() {
                        return optimisticResult;
                    });
                }

                var deferred = $.Deferred();
                this.kClient.doRequest(requestObj, function(res) {
                    if (res && res.objectType === 'KalturaAPIException') {
                        deferred.reject(res);
                    } else {
                        deferred.resolve(res);
                    }
                }, false, deferred.reject);
                return deferred.promise();
            },

            log: function log() {
                var args = ['[KMSHISTORY]'].concat(Array.prototype.slice.call(arguments));
                mw.log(args.join('; '));
            }
        }));
    });

    function throttle(func, wait, options) {
        options = options || {};

        var context, args, result;
        var timeout = null;
        var previous = 0;
        var later = function() {
            previous = options.leading === false ? 0 : new Date().getTime();
            timeout = null;
            result = func.apply(context, args);
            if (!timeout) context = args = null;
        };

        return function() {
            var now = new Date().getTime();
            if (!previous && options.leading === false) {
                previous = now;
            }

            var remaining = wait - (now - previous);
            context = this;
            args = arguments;
            if (remaining <= 0 || remaining > wait) {
                if (timeout) {
                    clearTimeout(timeout);
                    timeout = null;
                }

                previous = now;
                result = func.apply(context, args);
                if (!timeout) {
                    context = args = null;
                }
            } else if (!timeout && options.trailing !== false) {
                timeout = setTimeout(later, remaining);
            }

            return result;
        };
    }

    function memoize(func, hasher) {
        var memoize = function(key) {
            var cache = memoize.cache;
            var address = '' + (hasher ? hasher.apply(this, arguments) : key);
            if (!(cache != null && hasOwnProperty.call(cache, address))) {
                cache[address] = func.apply(this, arguments);
            }

            return cache[address];
        };

        memoize.cache = {};

        return memoize;
    }
})(window.jQuery, window.mw);
