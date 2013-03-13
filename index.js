var Bucket       = require('range-bucket')
var EventEmitter = require('events').EventEmitter
var timestamp    = require('monotonic-timestamp')
var uuid         = require('node-uuid')
var duplex       = require('duplex')


var LiveStream   = require('level-live-stream')
var REDIS        = require('redis-protocol-stream')

var makeSchema   = require('./lib/schema')
//var cache        = require('./lib/cache')
//var sbMapReduce  = require('./lib/map')

//var Remote     = require('./remote')

//var DbOpener     = require('./lib/db-opener')
var BufferedOpener
                 = require('./lib/buffered-opener')
var ClientOpener = require('./lib/client-opener')
var MakeCreateStream
                 = require('./lib/stream')

//need a seperator that sorts early.
//use NULL instead?

var SEP = ' '
var DEFAULT = 'SCUTTLEBUTT'

module.exports = function (db, id, schema) {

  //none of these should be used.
  var sep = '\x00'

  var localDb     = db.sublevel('sb')
  var replicateDb = db.sublevel('replicate')
  var vectorDb    = db.sublevel('vector')

/*
  var prefix  = DEFAULT //TEMP
  var bucket  = Bucket(prefix  || DEFAULT)
  var _bucket = Bucket((prefix || DEFAULT)+'_R')
  var vector  = Bucket((prefix || DEFAULT)+'_V')
  var range   = bucket.range()
*/

  var sources = {}

  if('string' !== typeof id)
    schema = id, id = null

  id = id || uuid()

//  if(db.scuttlebutt) return db

//  hooks()(db)

  var match = makeSchema(schema, id)

  //create a new scuttlebutt attachment.
  //a document that is modeled as a range of keys,
  //rather than as a single {key: value} pair

  //WHY DID I DO THIS? - remove this and it works.
  //but it seems to be problem with r-array...
  function checkOld (id, ts) {
    return false
    if(sources[id] && sources[id] >= ts) return true
    sources[id] = ts
  }

  var _batch = [], queued = false

  function save() {
    if(!queued)
      process.nextTick(function () {
        db.batch(_batch)
        queued = false
        _batch = []
      })
    queued = true
  }

  db.scuttlebutt = function () {
    var args = [].slice.call(arguments)
    return db.scuttlebutt.open.apply(null, args)
  }

  db.scuttlebutt._checkOld = checkOld
  db.scuttlebutt._match = match
  db.scuttlebutt._localDb = localDb
  db.scuttlebutt._sep = sep
  function key() {
    return [].slice.call(arguments).join(sep)
  }

  localDb.pre(function (ch, add) {
    ch.key.split(sep)
  })

  var insertBatch =
  db.scuttlebutt._insertBatch = 
  function (_id, doc_id, ts, value) {
    ts = ts.toString()

    //WTF WHY WAS THIS BEING TRIGGERED?
    //if(checkOld(_id, ts)) return console.log('OLD', ts, value)
    //if(checkOld(_id, ts))
    //   console.log('write-old', _id, ts)

    _batch.push({
      key: key(doc_id, ts, _id),
      value: value, type: 'put',
      prefix: localDb
    })

    _batch.push({
      //the second time, so that documents can be rapidly replicated.
      key: key(_id, ts, doc_id),
      value: value, type: 'put',
      prefix: replicateDb
    })

    _batch.push({
      //also, update the vector clock for this replication range,
      //so that it's easy to recall what are the latest documents are.
      //this vector clock is for all the documents, not just this one...
      key: _id, value: ''+ts, type: 'put',
      prefix: vectorDb
    })

    save()
  }

//  db.scuttlebutt._bucket = bucket

  var deleteBatch =
  db.scuttlebutt._deleteBatch =
  function deleteBatch (_id, doc_id, ts) {

    _batch.push({
      key: key(doc_id, ts, _id),
      type: 'del', prefix: localDb
    })

    _batch.push({
      key: key(_id, ts, doc_id),
      type: 'del', prefix: replicateDb
    })

    save()
  }

  var dbO = new EventEmitter()
  dbO.open = function (doc_id, tail, callback) {
    if('function' === typeof tail) callback = tail, tail = true

    if(!doc_id) throw new Error('must provide a doc_id')
    var emitter
    if('string' === typeof doc_id) {
      emitter = match(doc_id)
    } else {
      emitter = doc_id
      doc_id = emitter.name
    }


    //read current state from db.
//    var opts = bucket.range([doc_id, 0, true], [doc_id, '\xff', true])
  //  opts.tail = tail

    var stream = LiveStream(localDb, {
          start: [doc_id, 0].join(sep),
          end: [doc_id, '~'].join(sep)
        })
        .on('data', function (data) {
          //ignore deletes,
          //deletes must be an update.
          if(data.type == 'del') return

          var ary    = data.key.split(sep)
          var ts     = Number(ary[1])
          var source = ary[2]
          var change  = JSON.parse(data.value)

          //if(checkOld(source, ts))
          //  console.log('read-old', source, ts)
          emitter._update([change, ts, source])
        })

    //this scuttlebutt instance is up to date with the db.
    
    var ready = false
    function onReady () {
      if(ready) return
      ready = true
      emitter.emit('sync')
      if(callback) callback(null, emitter)
    }

    stream.once('sync', onReady)
    stream.once('end' , onReady)

    emitter.once('dispose', function () {
      //levelup/read-stream throws if the stream has already ended
      //but it's just a user error, not a serious problem.
      try { stream.destroy() } catch (_) { }
    })

    //write the update twice, 
    //the first time, to store the document.
    //maybe change scuttlebutt so that value is always a string?
    //If i write a bunch of batches, will they come out in order?
    //because I think updates are expected in order, or it will break.

    function onUpdate (update) {
      var value = update[0], ts = update[1], id = update[2]
      insertBatch (id, doc_id, ts, JSON.stringify(value))
    }

    emitter.history().forEach(onUpdate)

    //track updates...
    emitter.on('_update', onUpdate)

    //an update is now no longer significant
    emitter.on('_remove', function (update) {
      var ts = update[1], id = update[2]
      deleteBatch (id, doc_id, ts)
    })

    return emitter
  }

  dbO.createStream = function () {
    var mx = MuxDemux(function (stream) {
      if(!db) return stream.error('cannot access database this end')

      if('string' === typeof stream.meta) {
        var ts = through().pause()
        //TODO. make mux-demux pause.

        stream.pipe(ts)
        //load the scuttlebutt with the callback,
        //and then connect the stream to the client
        //so that the 'sync' event fires the right time,
        //and the open method works on the client too.
        opener.open(stream.meta, function (err, doc) {
          ts.pipe(doc.createStream()).pipe(stream)
          ts.resume()
        })
      } else if(Array.isArray(stream.meta)) {
        //reduce the 10 most recently modified documents.
        opener.view.apply(null, stream.meta)
          .pipe(through(function (data) {
            this.queue({
              key: data.key.toString(), 
              value: data.value.toString()
            })
          }))
          .pipe(stream)
      }
    })
    //clean up
    function onClose () { mx.end() }
    db.once('close', onClose)
    mx.once('close', function () { db.removeListener('close', onClose) })

    return mx
  }

  dbO.view = function () {
    var args = [].slice.call(arguments)
    return db.mapReduce.view.apply(db.mapReduce, args)
  }

  db.on('close', function () {
    opener.emit('close')
  })

  var opener = BufferedOpener(schema, id).swap(dbO)

  db.scuttlebutt.open = opener.open
  db.scuttlebutt.view = opener.view
  db.scuttlebutt.createRemoteStream = MakeCreateStream(opener) //dbO.createStream

  db.scuttlebutt.createReplicateStream = function (opts) {
    opts = opts || {}
    var yourClock, myClock
    var d = duplex ()
    var outer = REDIS.serialize(d)
    d.on('_data', function (data) {
      if(data.length === 1) {
        //like a telephone, say
        if(''+data[0] === 'BYE') {
          d._end()
        } else {
          //data should be {id: ts}
          yourClock = JSON.parse(data.shift())
          console.log('YOUR CLOCK', yourClock)
          start()
        }
      } else {
        //maybe increment the clock for this node,
        //so that when we detect that a record has been written,
        //can avoid updating the model twice when recieving 
        var id = ''+data[0]
        var ts = Number(''+data[1])

        if(!myClock || !myClock[id] || myClock[id] < ts) {
          var doc_id = data[2]
          var value = data[3]
      
          insertBatch(id, doc_id, ts, value)
          myClock[id] = ts
        }
      }
    })

    function start() {
      if(!(myClock && yourClock)) return

      var clock = {}
      for(var id in myClock)
        clock[id] = ''

      for(var id in yourClock)
        clock[id] = yourClock[id]

      var started = 0
      for(var id in clock) {
        (function (id) {
          started ++
          var _opts = {
            start: [id, clock[id]].join(sep),
            end  :  [id, '\xff'].join(sep),
            tail : opts.tail
          }
          //TODO, merge stream that efficiently handles back pressure
          //when reading from many streams.
          var stream = LiveStream(replicateDb, _opts)
            .on('data', function (data) {
              var ary = data.key.split(sep)
              ary.push(data.value)
              d._data(ary)
            })
            .once('end', function () {
              if(--started) return
              if(opts.tail === false) d._data(['BYE'])
            })

          d.on('close', stream.destroy.bind(stream))

        })(id);
      }
    }

    db.scuttlebutt.vectorClock(function (err, clock) {
      myClock = clock
      d._data([JSON.stringify(clock)])
      start()
    })

    return outer
  }

  //read the vector clock. {id: ts, ...} pairs.
  db.scuttlebutt.vectorClock = function (cb) {
    var clock = {}
    vectorDb.createReadStream()
      .on('data', function (data) {
        clock[data.key] = Number(''+data.value)
      })
      .on('close', function () {
        cb(null, clock)
      })
  }
}
