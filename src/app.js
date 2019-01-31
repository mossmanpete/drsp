const $ = require('jquery')
require('events').EventEmitter.defaultMaxListeners = 100;

const IPFS = require('ipfs')
const Room = require('ipfs-pubsub-room')

const CRDT = require('delta-crdts')
const RegType = CRDT('lwwreg')
const codec = require('delta-crdts-msgpack-codec')

const ipfs = new IPFS({
  repo: repo(),
  EXPERIMENTAL: {
    pubsub: true
  },
  config: {
    Addresses: {
      Swarm: [
        '/dns4/ws-star.discovery.libp2p.io/tcp/443/wss/p2p-websocket-star',
        '/dns4/wrtc-star.discovery.libp2p.io/tcp/443/wss/p2p-webrtc-star'
      ]
    }
  }
})
var info = undefined; // will be defined as soon as ipfs connects

const roomSize = 9; // always odd so player can be in center
// number of tiles per side of a room
const mapSize = 3; // number of rooms per side (all in a grid)
// pos [0,0] is at the top left of the top left map tile,
//  [roomSize*mapSize-1, roomSize*mapSize-1] is the bottom right

/***** A note about postition notation *****

all positions (usually in the form pos = [num, num]) should be absolute

i , j refer to position in an individual map/CRDT array

r , c refer to row and column of the actual displayed grid

map does not wrap around

*/
var charPos = [roomSize + (roomSize-1)/2, roomSize + (roomSize-1)/2]; // always in the center of the room

var peers = {};

var rooms = {};
var valArrs = {};

const posToRC = function(pos) {
  // matters because always at the center
  let r = pos[0] - charPos[0] + (roomSize-1)/2
  let c = pos[1] - charPos[1] + (roomSize-1)/2
  return (r < 0 || c < 0 || r >= roomSize || c >= roomSize) ? undefined : [r,c];
}

const posToIJ = function(pos) {
  return [(pos[0] + roomSize) % roomSize , (pos[1] + roomSize) % roomSize]
}

const rcToPos = function(r, c) {
  // charPos is absolute player position
  return [charPos[0] + r - (roomSize-1)/2, charPos[1] + c - (roomSize-1)/2]
}

const updateBtn = function(r, c, valreg) {
  // $('#btn').text(valreg.value())
  if (valreg === undefined || valreg === null){
    $('#r' + r + ' #c' + c + ' button').css('background-color', 'gray')
  } else {
    $('#r' + r + ' #c' + c + ' button').css('background-color', (valreg.value() === 1) ? 'black' : 'white')
  }
}

const showPeer = function(pos) {
  peerrc = posToRC(pos);
  if (!(peerrc === undefined)){
    $('#r' + peerrc[0] + ' #c' + peerrc[1] + '').addClass('peer')
  }
}

const unshowPeer = function(pos) {
  peerrc = posToRC(pos);
  if (!(peerrc === undefined)){
    $('#r' + peerrc[0] + ' #c' + peerrc[1] + '').removeClass('peer')
  }
}

const sendPos = function(room, pos) {
  if (room === undefined){
    console.log('sendPos: room undefined')
    return
  }
  const rawDelta = codec.encode({type: 'pos', p0: pos[0], p1: pos[1]})
  room.broadcast(rawDelta)
}

const getRoomID = function(pos){
  // absolute game pos
  if (pos[0] < 0 || pos[1] < 1 || pos[0] >= mapSize*roomSize || pos[1] >= mapSize*roomSize) {
    return undefined
  }
  return 'ddocs-' + Math.floor(pos[0]/roomSize) + '-' + Math.floor(pos[1]/roomSize)
}

// sets up a new room and CRDT
const setupRoom = function(pos) {
  let roomID = getRoomID(pos)
  console.log('setting up new room! ' + roomID)
  // roompos is top left
  roompos = [Math.floor(pos[0]/roomSize), Math.floor(pos[1]/roomSize)]
  let room = Room(ipfs, roomID)

  // now started to listen to room
  room.on('subscribed', () => {
    console.log('Now connected!')
  })

  // first the CRDT
  let valarr = [];
  for(var i = 0; i < roomSize; i++) {
    valarr[i] = [];
    for(var j = 0; j < roomSize; j++) {
      valarr[i][j] = RegType(info.id + roomID + (roomSize+40)*i + j);
    }
  }
  valArrs[roomID] = valarr;

  // next set up all the callbacks
  room.on('peer joined', (peer) => {
    console.log('Peer joined room ' + roomID + ': ' + peer)
    // update pos
    peers[peer] = [0,0]
    showPeer(peers[peer])
    //send room
    for(var i=0; i<roomSize; i++) {
      for(var j=0; j<roomSize; j++) {
        const rawCRDT = codec.encode({type: 'delta', i: i, j: j, delta:valArrs[roomID][i][j].state()})
        setTimeout(() => {
          room.sendTo(peer, rawCRDT)
        }, (roomSize*i+j) * 25)
      }
    }
    // send pos
    const rawDelta = codec.encode({type: 'pos', p0: charPos[0], p1: charPos[1]})
    room.sendTo(peer, rawDelta)
  })

  room.on('peer left', (peer) => {
    console.log('Peer left room ' + roomID + ': ' + peer)
    unshowPeer(peers[peer])
    delete peers[peer];
  })

  room.on('message', (message) => {
    console.log('room: ' + roomID + ' message: ' + message)
    if (message.from === info.id){
      // it's from us. ignore it
      return;
    }
    let mess = codec.decode(message.data)
    if (mess['type'] === 'delta'){
      i = mess['i']
      j = mess['j']
      delta = mess['delta']
      valArrs[roomID][i][j].apply(delta)
      let rc = posToRC([roompos[0] + i, roompos[1] + j])
      updateBtn(rc[0], rc[1], valArrs[roomID][i][j])
    } else if (mess['type'] === 'pos') {
      unshowPeer(peers[message.from])
      peers[message.from] = [mess['p0'], mess['p1']]
      showPeer(peers[message.from])
    }
  })

  rooms[roomID] = room
}

const getRoom = function(pos) {
  // pos is absolute game position over the whole map
  let roomID = getRoomID(pos)
  if (roomID === undefined) {
    return undefined;
  }

  if (!(roomID in rooms)) {
    // need to create a new room
    setupRoom(pos)
  }
  return rooms[roomID];
}

const getValArr = function(pos) {
  // pos is absolute game position over the whole map
  let roomID = getRoomID(pos)
  if (roomID === undefined) {
    return undefined;
  }

  if (!(roomID in rooms)) {
    // need to create a new room
    setupRoom(pos)
  }
  return valArrs[roomID];
}

const refreshMap = function() {
  for(var r = 0; r < roomSize; r++) {
    for(var c = 0; c < roomSize; c++) {
      pos = [charPos[0] + r - (roomSize-1)/2, charPos[1] + c - (roomSize-1)/2]
      unshowPeer(pos)
      let valarr = getValArr(pos)
      if (valarr === undefined) {
        updateBtn(r, c, undefined)
      } else {
        let ij = posToIJ(pos)
        updateBtn(r, c, valarr[ij[0]][ij[1]])
      }
    }
  }
  for (key in peers) {
    if (peers.hasOwnProperty(key)) {           
        showPeer(peers[key])
    }
  }
}

// IPFS node is ready, so we can start using ipfs-pubsub-room
ipfs.once('ready', () => ipfs.id((err, infoArg) => {
  if (err) { throw err }
  info = infoArg;
  console.log('IPFS node ready with address ' + info.id)

  // build table
  for(var i = 0; i < roomSize; i++) {
    $('#table').append('<tr id="r' + i + '">')
    for(var j = 0; j < roomSize; j++) {
      $('#r' + i).append('<td id="c' + j + '"><button/></td>')
    }
  }
  $('#r' + (roomSize-1)/2 + ' #c' + (roomSize-1)/2 + '').addClass('player')

  refreshMap()
  sendPos(getRoom(charPos), charPos)

  $('button').click((e) => {
    // assumes roomSize <= 10
    let c = e.currentTarget.parentNode.id.slice(1)
    let r = e.currentTarget.parentNode.parentNode.id.slice(1)
    let pos = rcToPos(parseInt(r), parseInt(c))
    let roomID = getRoomID(pos)
    if (roomID === undefined){
      updateBtn(r, c, undefined)
      return
    }
    let room = getRoom(pos)
    let ij = posToIJ(pos)
    let val = valArrs[roomID][ij[0]][ij[1]]
    const delta = val.write((new Date).getTime(), (val.value() == null) ? 1 : (1 - val.value()))
    updateBtn(r, c, val)
    const rawDelta = codec.encode({type: 'delta', i: ij[0], j: ij[1], delta: delta})
    room.broadcast(rawDelta)
  })


  document.getElementById("body").onkeypress = function(e) {
    let prevroom = getRoom(charPos)
    if (e['key'] == 'w'){
      charPos[0] -= 1;
    } else if (e['key'] == 's'){
      charPos[0] += 1;
    } else if (e['key'] == 'a'){
      charPos[1] -= 1;
    } else if (e['key'] == 'd'){
      charPos[1] += 1;
    } else {
      console.log('unsupported keypress')
      return
    }
    let newroom = getRoom(charPos)
    sendPos(newroom, charPos)
    if (newroom !== prevroom) {
      sendPos(newroom, charPos)
    }
    refreshMap()
  }
}))

function repo() {
  return 'ipfs-crdts-demo/' + Math.random()
}
