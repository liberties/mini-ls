import request from "./request";

var storage = window.localStorage;

var keyName = "forchange-";

var errMsg = '';//用来告知开发者使用了换源cdn之后，是否解决了cdn下载失败的问题

var dom = document.querySelector("head");

function getSpace() { //爆空间的处理方案
  var size = 10;
  var filter = ["app", "manifest", "vendor"];
  Object.keys(localStorage).some(function(key) {
    //空间不够，删除10条记录
    if (key.indexOf(keyName) != -1 && filter.indexOf(key) == -1) {
      size--;
      localStorage.removeItem(key);
    }
    if (size < 0) {
      return true;
    }
    return false;
  });
  if (size > 7) {
    localStorage.clear();
  }
}

function formateLocalObj(item, content) { //数据格式处理
  var url = typeof item.url == 'string' ? item.url : item.url[0] ;
  var match = url.match(/\.(\w+)(\?.*)?$/i);
  return {
    url: url,
    content: content,
    ext: match ? match[1] : match
  };
}

var LsManger = {
  getSource(item) { //获取资源
		var times = 3;//资源下载失败，默认重试次数（更正：下载失败可能就是cdn问题，打算切多路）
    var promise = new Promise((rs, rj) => {
      var local = this._getLocal(item.key);//从本地存储拿数据，没有则走下载逻辑，有就直接返回
      if (local && (local.url == item.url || local.url == item.url[0] )) {//有本地存储，直接返回
        rs(local);
      } else {//没有本地存储，去下载
        this._fetchSource(item,times).then(local=>{
					rs(local);
				}).catch(e => {
					rj(e);
				});
      }
    }).catch(e => {
      throw new Error(e);
    });
    return promise;
  },
  _fetchSource(item,times = 1,err) {//拿数据，用到request
    var url = this._getSourceUrl(item);
    this._indexAdd(item);
    return request({ url: url }).then(res => {
      (!errMsg && err) ? errMsg = '换源下载成功:'+url : ''; 
      var local = formateLocalObj(item, res.content);
      setTimeout(() => {
        this._setLocal(item.key, local);//延迟将资源存入本地，让浏览器能够留出性能处理其他事情
			}, 1000);
			return local;
    }).catch(e => {
			if (times < 1) {//下载失败的重试逻辑
				throw new Error(e+' ， 已经重试过3次，文件下载异常：'+url);
				return;
			}
			return this._fetchSource(item, --times, true);
		});
  },
  _getSourceUrl(item){//切多路资源下载地址，因为资源有可能下载失败
    var url = '';
    item.index = item.index || 0;
    if(typeof item.url == 'string'){
      url = item.url;
    }else{
      url = item.url[item.index];
    }
    return url;
  },
  _indexAdd(item){
    if(item.index < item.url.length - 1){
      item.index++;
    }
  },
  _getLocal(key) {
    var obj = null;
    try {
      var obj = JSON.parse(storage.getItem(keyName + key));
    } catch (error) {
      throw new Error(key + ": 数据有问题");
    }
    return obj;
  },
  _setLocal(key, value) {
    try {
      storage.setItem(keyName + key, JSON.stringify(value));
    } catch (error) {
      getSpace();
      this._setLocal(key, value);
    }
  }
};

var Pawn = {
  ob: false,//观察者触发依赖收集
  target: 0,//当前数据id
	locals: {},//数据集合
	max:0,
  hash:{},//key对应的数据id
  success:null,//成功处理
	error:null,//异常处理的函数
	_setMax(options) {//存在异步情况,上一波add的promise还没执行完毕，下一波又来了，所以需要累加
    this.max += options.length;
  },
  add(options) {
    return new Promise((rs, rj) => {
      options.forEach((item, idx) => {
				idx += this.max;//累加，防止下一波add覆盖上一波add的数据
				if(this.locals[this.hash[item.key]]){return }//有缓存就不用执行了
        LsManger.getSource(item)//获取数据
          .then(local => {
						this.hash[item.key] = idx;//将资源的key和idx对应，便于某些情况用key也能找到对应的资源
            this.locals[idx] = local;//将idx作为资源对应的id，因为是下标，根据这个顺序来处理依赖关系，idx小的靠上
            errMsg && (this.error = ()=>{rj(errMsg)});//成功处理，主要用于告知用户换源是否成功
            this.ob = true;//开始根据依赖关系将对应的js打入html
          })
          .catch(e => {//报异常，可能是js跨域或者其他问题，这里统一对单个文件进行降级处理，不影响其他js，最大程度利用缓存
						this.hash[item.key] = idx;//同上，关联key和idx
						this.locals[idx] = formateLocalObj(item);//同样将数据存入，没有content的local对象，在插入时自动匹配，用src插入
						this.error = ()=>{rj(e)};//异常处理，待所有的资源文件加载完了，抛出异常给上层，预留接口给他们处理
						this.ob = true;//开始依赖处理
          });
			});
      this._setMax(options);//累加
    });
	},
};

var util = {
	ext: { js: "script", css: "style" },
	extOut:{js:'script',css:'link'},
	link:{js:'src',css:'href'},
	_createElement(local) {//创建element的过程
		var element = null;

		if(local.content){
			element = document.createElement(this.ext[local.ext] || "script");
			element.innerHTML = local.content;
		}else{
			element = document.createElement(this.extOut[local.ext] || "script");
			element[this.link[local.ext] || "src"] = local.url;
			if(local.ext == 'css'){
				element.rel="stylesheet"
			}
    }
    if(local.ext == 'js'){
      element.crossorigin = true;
      element.async = false;
      element.defer = true;
    }
    return element;
  },
  _appendToPage(fragment) {
    dom.appendChild(fragment);
  },
}

var depManage = {//依赖处理，主要用来处理外链js和内联js的依赖顺序问，内联js上html就执行，外链js还要等待js完全下载。
  depArr:[],
  depStatus:false,
  _isDep:function(element,id){
    if(element.src){//说明降级过，引入外链js，需要处理外链js和内联js的依赖顺序问题
      depManage.depStatus = true;
      depManage.depArr.push(element);
    }else if(depManage.depStatus){//依赖状态发生改变，开始处理依赖
      var depArr = depManage.depArr;
      depArr.push(Pawn.locals[id]);//拿到外链后面的那个内联js
      Pawn.locals[id] = null;//置空
      depArr[depArr.length-2].onload = function(){//数组内连贯的最后一个外链js绑定onload，load之后开始打入内联js
        Pawn.locals[id] = depArr[depArr.length-1];//置空之后，还原
        depManage.depArr = [];//重新初始化数据
        depManage.depStatus = false;//重新初始化数据
        Pawn.ob = true;//依赖处理
      }
      return true;
    }
    return false;
  }
}

Object.defineProperty(Pawn, "ob", {//观察，有变动说明有资源处理完成，根据相应的依赖顺序，来按顺序把js插入到html中
	set: function(key) {
		var fragment = document.createDocumentFragment();
		var size = Object.keys(Pawn.locals).length, depStatus;
		for (var i = Pawn.target; i < Pawn.max; i++) {
			if (Pawn.locals[i]) {//从前往后，先处理第一个资源，依次进行
        var element = util._createElement(Pawn.locals[i]);
        if(depManage._isDep(element,i)){//如果有外链和内联同时存在的情况，就break
          break;
        }
        fragment.appendChild(element);
        Pawn.target++;
			}else {//如果第二第三个资源下载完成，第一个没下载完成，则退出，因为第一个资源默认为第二第三个依赖，script在第二个和第三个之上
				break;
			}
		}
		util._appendToPage(fragment);//将代码片段打入html
    if (size == Pawn.max) {//如果有异常，则要处理异常逻辑
      if(typeof Pawn.error == 'function'){
        Pawn.error();
        Pawn.error = null;
        errMsg = '';
      }
		}
	}
});

export default Pawn ;
