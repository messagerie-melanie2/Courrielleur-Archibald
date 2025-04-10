var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");

const Services = globalThis.Services;
const eventEmitter = new ExtensionCommon.EventEmitter();

var domapi = class extends ExtensionCommon.ExtensionAPIPersistent {

        
    PERSISTENT_EVENTS = {
        onEventCallBack({ fire }) {
            function callback(event, name) {
                return fire.async(name);
            }
            eventEmitter.on("dom-api-event", callback);
            return {
                unregister: () => {
                    eventEmitter.off("dom-api-event", callback);
                },
                convert(newFire) {
                    fire = newFire;
                },
            };
        },
    }


    getAPI(context) {

        function getWindowFromId(windowId) {
            return context.extension.windowManager.get(windowId).window;
        }

        /**
         * Load text from a file
         * 
         * @param {string} htmlFile 
         * @param {object} window
         * @returns noeud html correspondant au text
         */
        async function loadFileContent(htmlFile, window) {

            let htmlFileUri = context.extension.getURL(htmlFile);
            let response = await window.fetch(htmlFileUri);

            if(!response.ok) {
                throw new Error("Problème de chargement du fichier");
            }
 
            return response.text();
        }

        /**
         * Convertit texte brute en noeuds html
         * 
         * @param {string} text 
         * @param {object} window 
         * @returns le noeud html
         */
        function textToNode(text, window) {
            let template = window.document.createElement('template');
            template.innerHTML = text;
            
            let childList = template.content.childNodes;

            if(childList.lenghts > 1) {
                throw new Error("Component should be a unique node")
            }

            return childList[0];
        }

        return {
            domapi : {
                /**
                 * Integre un script dans un sous document du DOM principal
                 * 
                 * @param {string} scriptFile 
                 * @param {string} destinationId 
                 * @param {integer} windowId
                 * @param {string} scriptId 
                 */
                async injectScriptInDom(scriptFile, windowId, destinationId, scriptId) {

                    let window = getWindowFromId(windowId);
                    let scriptFileUri = context.extension.getURL(scriptFile);
                    let targetedElement = destinationId == "" ?
                        window.document : window.document.getElementById(destinationId);

                    let script = window.document.createElement("script");
                    script.id = scriptId;
                    script.src = scriptFileUri

                    attachElementToHead(script, targetedElement);
                },

                /**
                 * Transmet des parametres au context de la fenetre pour être exploité par les scripts de l'extension,
                 * accesibles via window['clé'] depuis les scripts
                 *
                 * @param {object} parameters : differents parametres au format [{'key': ..., 'value': ...)}, ...]
                 * @param {integer} windowId
                 * */
                async setInputs(parameters, windowId) {
                    let window = getWindowFromId(windowId);
                    for(let param of parameters) {
                        window[param['key']] = param['value'];
                    }
                },

                /**
                 * Integre une feuille de style dans dans un sous document du DOM principal
                 * 
                 * @param {string} cssFile 
                 * @param {integer} windowId 
                 * @param {string} destinationId 
                 * @param {string} baliseId 
                 */
                async injectCssInDom(cssFile, windowId, destinationId, baliseId) {

                    let window = getWindowFromId(windowId);
                    let cssFileUri = context.extension.getURL(cssFile);
                    let targetedElement = destinationId == "" ? 
                        window.document : window.document.getElementById(destinationId);
                    
                    let styleSheet = window.document.createElement('link');
                    styleSheet.rel = "stylesheet";
                    styleSheet.href = cssFileUri;
                    styleSheet.id = baliseId;
    
                    attachElementToHead(styleSheet, targetedElement);
                },

                /**
                 * Integre du html tiré d'un fichier, le fichier doit contenir un noeud parent unique.
                 * 
                 * @param {string} htmlFile 
                 * @param {integer} windowId 
                 * @param {string} destinationId 
                 */
                async addCustomHTMLComponent(htmlFile, windowId, destinationId, position) {

                    let window = getWindowFromId(windowId);
                    let targetedElement = window.document.getElementById(destinationId);
                    let htmlText = await loadFileContent(htmlFile, window);
                    let htmlNode = textToNode(htmlText, window);
                    
                    targetedElement.insertBefore(htmlNode, targetedElement.children[position]);
                },

                /**
                 * Savoir si un élément existe dans le document à l'aide d'un query selector
                 * 
                 * @param {string} querySelector
                 * @param {integer} windowId
                 * @returns {boolean} if the node exist in the document
                 */
                async doesElementExist(querySelector, windowId) {
                    let window = getWindowFromId(windowId);
                    return window.document.querySelector(querySelector) != null;
                },

                /**
                 * Retire un noeud du document
                 * 
                 * @param {string} querySelector 
                 * @param {integer} windowId 
                 */
                async removeNode(querySelector, windowId) {
                    let window = getWindowFromId(windowId);
                    let targetedElement = window.document.querySelector(querySelector);
                    targetedElement.remove();
                },

                /**
                 * Définit une fonction callback appelable par les éléments injecté dans le DOM
                 * 
                 * @param {function} event 
                 * @param {integer} windowId 
                 * @param {string} eventId 
                 */
                async defineCallback(windowId, eventId) {
                    let window = getWindowFromId(windowId);
                    window[eventId] = (parameters) => {
                        eventEmitter.emit("dom-api-event", {"eventId": eventId, "parameters": parameters});
                    };
                },

                onEventCallBack: new ExtensionCommon.EventManager({
                    context,
                    module: "domapi",
                    event: "onEventCallBack",
                    extensionApi: this,
                    
                }).api(),
            }
        }
    }
}


function attachElementToHead(element, subdocument) {
    let head = subdocument.getElementsByTagName("head")[0];
    if(head == null) {
        throw new Error("specified node isn't a subdocument");
    }
    head.appendChild(element);
}
