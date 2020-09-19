'use strict';

/*
ここで行っていること
Cloud Firestore の problems コレクションに、追加や削除されたときに
Cloud Storage の problemImages/ にある画像に対して処理を行います。

● problems コレクションにドキュメントが追加されたとき、または変更が加えられた
ときで、かつ、problems/{documentId}.imageRequired = true の場合、
problems/{documentId}.basePicturePath の示す、Cloud Storage 上にアップロード
された画像ファイルを背景として、
１．problems/{documentId}.primitives の内容に従ってプリミティブを配置する
２．problems/{documentId}.trimXXX に従ってトリミングを行う
３．problemImages/ に完成画像とサムネイルを書き出す。これらのパスとURLは
   problems/{documentId}.completedImageURL, completedImageThumbURL に保存する。
   パスの命名規則は、
        完成画像：COMP_課題のドキュメントID.png (png?)
        サムネイル：THUMB_課題のドキュメントID.png

● problems コレクションからドキュメントが削除されたとき
１．削除されたドキュメントの、ドキュメントから、
    完成画像を削除する
    サムネイル画像を削除する
*/

const functions = require('firebase-functions');
const adminjs = require('./admin');

const mkdirp = require('mkdirp');
const path = require('path');
const os = require('os');
const fs = require('fs');
const Canvas = require('canvas');
const { exception } = require('console');
const createCanvas = Canvas.createCanvas;
const loadImage = Canvas.loadImage;
const ExifImage = require('exif').ExifImage;


// トリミング画像に付けるプレフィックス名
const COMPLETED_PREFIX = 'completed_';


// サムネイルのサイズ
const THUMB_SIZE = 200;

// サムネイルファイル名に付けるプレフィックス名
const THUMB_PREFIX = 'thumb_';


/*
 * 汎用関数
 */

//キャンバスをローカルパスに保存
function saveCanvas(canvas, contentType, localPath) {
  var b64data = canvas.toDataURL(contentType).split(',')[1];
  var buffer = new Buffer(b64data, 'base64');
  fs.writeFileSync(localPath, buffer);
}

//座標を回転
function rotate(x, y, radian) {
    var cosr = Math.cos(radian);
    var sinr = Math.sin(radian);
    var nx = x * cosr - y * sinr;
    var ny = x * sinr + y * cosr;
    return [nx, ny];
}

//線の座標から矢印部分の座標を生成する
function createArrowOffset(p1x, p1y, p2x, p2y, allowLength, allowAngle) {
    var vx = (p1x - p2x);
    var vy = (p1y - p2y);
    var d = Math.sqrt(vx * vx + vy * vy);
    vx = vx / d * allowLength;
    vy = vy / d * allowLength;

    var a = rotate(vx, vy, allowAngle);
    var b = rotate(vx, vy, -allowAngle);

    return [
        a[0] + p2x, a[1] + p2y,
        b[0] + p2x, b[1] + p2y,
    ];
}



/*
 * problemsコレクションに変更があった場合に呼び出される
 * 
 */
exports.handleImagesForProblems = functions.firestore
  .document('problems/{documentID}').onWrite(async (change, context) => {

  if (change.after.exists) {
      //コレクションが追加または変更された
      if (change.after.data().imageRequired) {
        console.log('課題のイメージ要求がありました');
        const message = await generateProblemImages(change.after.data(), change.after.id);
        return console.log('handleImagesForProblems: ' + message);
      } else {
        //コレクションが更新された
        //写真ありきのコレクションなので、写真が変更されることはない
        return console.log('handleImagesForProblems: イメージは更新しない');
      }
  } else {
    //コレクションが削除された
    console.log('課題が削除された');
    
    //const message = await deleteProblemImages(change.before.data(), change.before.id);
    const message = '処理しませんでした';
    
    return console.log('handleImagesForProblems: ' + message);
  }
});

async function generateProblemImages(snap, docID) {

    /*
     * 元画像の準備
     */

    //ベース画像のダウンロード
    const dlBaseImage = new DownloadFile(snap.basePicturePath);
    await dlBaseImage.download();

    //イメージ化
    var baseImage = await loadImage(dlBaseImage.localPath);

    //一時ファイルを削除
    dlBaseImage.deleteLocalFile();

    //トリム後のサイズでキャンバスを作成
    var canvas = createCanvas(
        baseImage.width * (1.0 - snap.trimLeft - snap.trimRight),
        baseImage.height * (1.0 - snap.trimTop - snap.trimBottom));
    var ctx = canvas.getContext('2d');

    //トリム分の座標補正を計算してキャンバスにベース画像を貼り付け
    var offsetX = -baseImage.width * snap.trimLeft;
    var offsetY = -baseImage.height * snap.trimTop;
    ctx.drawImage(baseImage, offsetX,  offsetY);


    //プリミティブを描画
    var snapshot = await adminjs.admin.firestore().collection('problems')
        .doc(docID).collection('primitives').get();

    //snapshot.docs.forEach((doc) => {
    //    drawPrimitive(ctx, offsetX, offsetY, doc.data());
    //});

    for (var i=0; i< snapshot.docs.length; i++) {
        drawPrimitive(ctx, offsetX, offsetY, snapshot.docs[i].data());
    }



    /*
     * 完成画像の準備と保存
     */
    
    const upCompImage = new UploadFile(
        COMPLETED_PREFIX + docID + '.jpg',
        'problemImages');

    //キャンバスをローカルファイルに保存
    saveCanvas(canvas, 'image/jpeg', upCompImage.localPath);

    //ストレージにアップロードする
    await upCompImage.upload();
    console.log('完成画像 ' + upCompImage.url);

    //サムネイル作成のためにトリムした画像を読み直す
    //※キャンバスから直接変換できなかったw
    const completedImage = await loadImage(upCompImage.localPath);

    //一時ファイルを削除する
    upCompImage.deleteLocalFile();



    /*
     * サムネイル画像の生成
     */

    canvas = createCanvas(THUMB_SIZE, THUMB_SIZE);
    ctx = canvas.getContext('2d');

    ctx.beginPath();
    ctx.fillStyle = "rgba(255, 255, 255, 0.0)";
    ctx.fillRect(0, 0, THUMB_SIZE, THUMB_SIZE);
    ctx.stroke();

    var scale_x = THUMB_SIZE / completedImage.width;
    var scale_y = THUMB_SIZE / completedImage.height;
    var scale = (scale_x < scale_y) ? scale_x : scale_y;

    var dw = completedImage.width * scale;
    var dh = completedImage.height * scale;
    ctx.drawImage(completedImage,
        0, 0, completedImage.width, completedImage.height,
        (THUMB_SIZE - dw) / 2, (THUMB_SIZE - dh) / 2, dw, dh);



    /*
     * サムネイル画像の準備と保存
     */

    const upThumbImage = new UploadFile(
        THUMB_PREFIX + docID + '.jpg',
        'problemImages');

    //キャンバスをローカルファイルに保存
    saveCanvas(canvas, 'image/jpeg', upThumbImage.localPath);

    //ストレージにアップロードする
    await upThumbImage.upload();
    console.log('サムネイル ' + upThumbImage.url);

    //一時ファイルを削除する
    upThumbImage.deleteLocalFile();



    /*
     * ＤＢ保存
     */

    var data = {};
    data['imageRequired'] = false;
    data['completedImageURL'] = upCompImage.url;
    data['completedImageThumbURL'] = upThumbImage.url;
    await adminjs.admin.firestore().collection('problems').doc(docID).update(data);

    return upThumbImage.url;
}

var dimIndices = [
    "PrimitiveSizeType.XS",
    "PrimitiveSizeType.S",
    "PrimitiveSizeType.M",
    "PrimitiveSizeType.L",
    "PrimitiveSizeType.XL"
];
var dimensions = [
    {'radius': 20.0, 'width': 4.0},
    {'radius': 30.0, 'width': 4.0},
    {'radius': 40.0, 'width': 4.0},
    {'radius': 50.0, 'width': 4.0},
    {'radius': 60.0, 'width': 4.0}
];

var txtIndices = [
    "PrimitiveType.StartHold",
    "PrimitiveType.StartHold_Hand",
    "PrimitiveType.StartHold_Foot",
    "PrimitiveType.StartHold_RightHand",
    "PrimitiveType.StartHold_LeftHand",
    "PrimitiveType.GoalHold",
    "PrimitiveType.Bote",
    "PrimitiveType.Kante"
];
var textInfos = [
    {'text': 'Ｓ', 'fontSize': 60.0},
    {'text': '手', 'fontSize': 60.0},
    {'text': '足', 'fontSize': 60.0},
    {'text': '右', 'fontSize': 60.0},
    {'text': '左', 'fontSize': 60.0},
    {'text': 'Ｇ', 'fontSize': 60.0},
    {'text': 'ボテ', 'fontSize': 60.0},
    {'text': 'カンテ', 'fontSize': 60.0}
];

function drawPrimitive(ctx, offsetX, offsetY, primitive) {
    var drawPosX = primitive.positionX + offsetX;
    var drawPosY = primitive.positionY + offsetY;

    ctx.strokeStyle = 'rgb('+primitive.color+')';
    ctx.fillStyle = 'rgb('+primitive.color+')';

    var dimIndex = dimIndices.indexOf(primitive.sizeType);
    if (dimIndex < 0) throw new Error('Unknown primitive sizeType');
    var radius = dimensions[dimIndex]['radius'];
    ctx.lineWidth = dimensions[dimIndex]['width'];

    var txtIndex = txtIndices.indexOf(primitive.type);
    var text, textWidth, textHeight;
    if (txtIndex >= 0) {
        text = textInfos[txtIndex]['text'];
        ctx.font = textInfos[txtIndex]['fontSize'] + "px 'meiryo ui'";
        ctx.textBaseline = "middle";

        //テキストの大きさを測定
        textWidth = ctx.measureText(text).width;
        textHeight = textWidth / text.length;
    }

    var left, top;
    if (primitive.type === "PrimitiveType.Bote" || 
        primitive.type === "PrimitiveType.Kante") {

        left = drawPosX - textWidth / 2.0;
        top = drawPosY - textHeight / 2.0;

        //テキストを描画
        ctx.fillText(text, drawPosX - textWidth / 2, drawPosY, 1000);

        //線を引く準備
        var p1x, p1y, p2x, p2y;
        if (primitive.subItemPosition === "PrimitiveSubItemPosition.Center") {
            p2x = 0;//dummy
        }
        else if (primitive.subItemPosition === "PrimitiveSubItemPosition.Right") {
            p1x = left + textWidth;
            p1y = top + textHeight / 2.0;
            p2x = p1x + radius * 2.0;
            p2y = p1y;
        }
        else if (primitive.subItemPosition === "PrimitiveSubItemPosition.Bottom") {
            p1x = left + textWidth / 2.0;
            p1y = top + textHeight;
            p2x = p1x;
            p2y = p1y + radius * 2.0;
        }
        else if (primitive.subItemPosition === "PrimitiveSubItemPosition.Left") {
            p1x = left;
            p1y = top + textHeight / 2.0;
            p2x = p1x - radius * 2.0;
            p2y = p1y;
        }
        else if (primitive.subItemPosition === "PrimitiveSubItemPosition.Top") {
            p1x = left + textWidth / 2.0;
            p1y = top;
            p2x = p1x;
            p2y = p1y - radius * 2.0;
        }
        else
            throw new Error('Unknown PrimitiveSubItemPosition');

        if (p1x !== undefined) {
            //メインの線を引く
            ctx.beginPath();
            ctx.moveTo(p1x, p1y);
            ctx.lineTo(p2x, p2y);

            //先の矢印かカンテラインを引く
            var ang, len;
            if (primitive.type === "PrimitiveType.Bote") {
                ang = 0.55;
                len = 10.0;
            } else {
                ang = Math.PI / 2.0;
                len = 20.0;
            }
            var ab = createArrowOffset(p1x, p1y, p2x, p2y, len, ang);
            ctx.moveTo(ab[0], ab[1]);
            ctx.lineTo(p2x, p2y);
            ctx.lineTo(ab[2], ab[3]);
            ctx.stroke();
        }
    } else {
        //円を描く
        ctx.beginPath();
        ctx.arc(drawPosX, drawPosY, radius, 0, Math.PI * 2);
        ctx.stroke();

        //テキストを書く
        if (text !== undefined) {
            //left = drawPosX - textWidth / 2.0;
            //top = drawPosY - textHeight / 2.0;

            var textPosX, textPosY;
            if (primitive.subItemPosition === "PrimitiveSubItemPosition.Center") {
                textPosX = drawPosX - textWidth / 2.0;
                textPosY = drawPosY;
            }
            else if (primitive.subItemPosition === "PrimitiveSubItemPosition.Right") {
                textPosX = drawPosX + radius;
                textPosY = drawPosY;
            }
            else if (primitive.subItemPosition === "PrimitiveSubItemPosition.Bottom") {
                textPosX = drawPosX - textWidth / 2.0;
                textPosY = drawPosY + radius;
            }
            else if (primitive.subItemPosition === "PrimitiveSubItemPosition.Left") {
                textPosX = drawPosX - radius - textWidth;
                textPosY = drawPosY;
            }
            else if (primitive.subItemPosition === "PrimitiveSubItemPosition.Top") {
                textPosX = drawPosX - textWidth / 2.0;
                textPosY = drawPosY - radius - textHeight;
            }
            else
                throw new Error('Unknown PrimitiveSubItemPosition');

            //テキストを描画
            ctx.fillText(text, textPosX, textPosY, 1000);
        }
    }
}

class DownloadFile {
    constructor(storagePath) {
        this.storagePath = storagePath;
        this.storageDir = path.dirname(storagePath);
        this.fileName = path.basename(storagePath); //拡張子はついてる

        this.bucketFile = adminjs.admin.storage().bucket().file(this.storagePath);

        this.localDir = os.tmpdir();
        this.localPath = path.join(this.localDir, this.fileName);
    }

    deleteLocalFile() {
        try {
            fs.unlinkSync(this.localPath);
        // eslint-disable-next-line no-empty
        } catch (e) {
        }
    }

    deleteStorageFile() {
        try {
            this.bucketFile.delete();
        // eslint-disable-next-line no-empty
        } catch (e) {
        }
    }

    async download() {
        await mkdirp(this.localDir);
        await this.bucketFile.download({destination: this.localPath});
    }
}

class UploadFile {
    constructor(localFileName, storageDir) {
        this.localFileName = localFileName;
        this.localDir = os.tmpdir();
        this.localPath = path.join(this.localDir, this.localFileName);

        this.storageDir = storageDir;
        this.storagePath = path.join(this.storageDir, localFileName);

        this.bucketFile = adminjs.admin.storage().bucket().file(this.storagePath);

        this.url = '';
    }

    deleteLocalFile() {
        try {
            fs.unlinkSync(this.localPath);
        // eslint-disable-next-line no-empty
        } catch (e) {
        }
    }

    deleteStorageFile() {
        try {
            this.bucketFile.delete();
        // eslint-disable-next-line no-empty
        } catch (e) {
        }
    }

    async upload() {
        var ext = path.extname(this.localFileName).toUpperCase();
        var contentType;
        if (ext === '.JPG' || ext === '.JPEG')
            contentType = 'image/jpeg';
        else if (ext === '.PNG')
            contentType = 'image/png';
        else if (ext === '.GIF')
            contentType = 'image/gif';
        else
            contentType = 'image';

        await adminjs.admin.storage().bucket().upload(this.localPath, {
            destination:this.bucketFile,
            metadata: {contentType: contentType}
        });

        const result = await this.bucketFile.getSignedUrl(
            {action: 'read', expires: '03-01-2500'});

        this.url = result[0];
        return result[0];
    }

}