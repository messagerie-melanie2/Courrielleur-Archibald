ChromeUtils.import("resource:///modules/MailUtils.js");
ChromeUtils.import("resource:///modules/mailServices.js");

const FLAGS_DOSSIERS=Components.interfaces.nsMsgFolderFlags;


//liste des drapeaux des dossiers spéciaux à traiter lors de la création
var ARCH_DOSSIERS_SPECIAUX=[
  FLAGS_DOSSIERS.SentMail,
  FLAGS_DOSSIERS.Drafts,
  FLAGS_DOSSIERS.Inbox,
  FLAGS_DOSSIERS.Templates,
  FLAGS_DOSSIERS.Virtual
];


//nom du fichier des options
const ARCH_FICHIEROPTIONS="archibald.rdf";
//définition des options
const ARCH_OPTION_ARCHIVER	="A";
const ARCH_OPTION_IGNORER		="I";
const ARCH_OPTION_SUPPRIMER	="S";


//objet gestion des options des dossiers
function ArchibaldDossiers() {

  this.msgerreur="";

  //fonction de rappel de l'appelant
  this.rappel=null;

  this.datasource=null;
}

ArchibaldDossiers.prototype={

  // IncomingServer du compte
  _srvin:null,

  /* fonctions principales */

  //charge les options depuis le fichier rdf
  //rappel : fonction de rappel en fin de chargement
  ChargeFichierOptions: function(rappel) {

    this.msgerreur="";
    this.rappel=rappel;

    this.loadDataSource();
  },

  //validation des modifications
  ValideModifs: function() {

    ArchibaldTrace("ArchibaldDossiers ValideModifs");

    this.datasource.QueryInterface(Components.interfaces.nsIRDFRemoteDataSource).Flush();
  },

  //annulation des modifications
  AnnuleModifs: function() {

    ArchibaldTrace("ArchibaldDossiers AnnuleModifs");

    //restaurer les valeurs d'origine dans option.rdf
    let  rds=this.datasource.QueryInterface(Components.interfaces.nsIRDFRemoteDataSource);
    rds.Refresh(true);
  },

  //lecture message d'erreur
  GetMsgErreur: function() {

    return this.msgerreur;
  },

  //libelle de la boite a lettres
  //compteid: <proto>://<uid>@<serveur>
  GeLibelleBoite: function(compteid) {

    //libellé de la boîte à lettres
    let  ds=this.rdfService.GetDataSource("rdf:msgaccountmanager");
    let  cpt=this.rdfService.GetResource(compteid);
    let  pred=this.rdfService.GetResource("http://home.netscape.com/NC-rdf#Name");
    let  obj=ds.GetTarget(cpt, pred, true);
    if (obj instanceof Components.interfaces.nsIRDFLiteral){
      let  val=obj.Value;
      ArchibaldTrace("ArchibaldDossiers GeLibelleBoite:"+val);
      return val;
    }

    return "";
  },

  //Fixe l'option spécifié pour le dossier
  //dos	instance nsIMsgFolder du dossier à traiter
  //option	litteral de l'option (litteralArchiver,...)
  //force si false n'ecrase pas l'option si elle existe déjà
  //return true si succès false si erreur
  FixeOptionDossier: function(dos, option, force){

    let  rs=this.rdfService.GetResource(dos.URI);

    let  obj=this.datasource.GetTarget(rs, this.predMode, true);

    if (null==obj){
      //pas de valeur fixée
      this.datasource.Assert(rs, this.predMode, option, true);

    }	else if (force){
      this.datasource.Change(rs, this.predMode, obj, option);
    }
  },

  //positionne l'option suivant pour un dossier
  //dos	instance nsIMsgFolder du dossier à traiter
  SetDossierNextVal: function(dos) {

    let  rs=this.rdfService.GetResource(dos.URI);
    let  obj=this.datasource.GetTarget(rs, this.predMode, true);
    let  option=this.litteralIgnorer;

    if (null==obj){
      //pas de valeur fixée
      ArchibaldTrace("SetDossierNextVal:"+this.litteralIgnorer.Value);
      this.datasource.Assert(rs, this.predMode, this.litteralIgnorer, true);
    }
    else{
      if (obj.EqualsNode(this.litteralArchiver)){
        option=this.litteralIgnorer;
      }
      else if (obj.EqualsNode(this.litteralIgnorer)){
        option=this.litteralSupprimer;
      }
      else{
        option=this.litteralArchiver;
      }

      ArchibaldTrace("SetDossierNextVal option="+option.Value);
      this.datasource.Change(rs, this.predMode, obj, option);
    }

    this.PropageOptionSousDossiers(dos, option, true);
  },


  GetDataSource: function() {

    return this.datasource;
  },

  //Retourne la valeur de l'option pour un dossier
  LitOptionDossierVal: function(uridos){

    if (null==this.datasource) {
      //valeur par défaut
      return ARCH_OPTION_ARCHIVER;
    }

    let  rs=this.rdfService.GetResource(uridos);
    let  obj=this.datasource.GetTarget(rs, this.predMode, true);

    if (null==obj){
      //valeur par défaut
      return ARCH_OPTION_ARCHIVER;
    }
    if (obj instanceof Components.interfaces.nsIRDFLiteral){
      return obj.Value;
    }

    //valeur par défaut
    return ARCH_OPTION_ARCHIVER;
  },

  //initialisation des options par défaut des dossiers d'un compte
  //le fichier des options doit etre charge avant usage
  //serverkey: identifiant serveur entrant
  SetupDossiersCompte: function(serverkey) {

    ArchibaldTrace("SetupDossiersCompte serverkey="+serverkey);

    if (null==this.datasource) {
      this.msgerreur=ArchibaldMessageFromId("archibaldErrRDF")
      return false;
    }

    this._srvin=this.accman.getIncomingServer(serverkey);

    //dossier Corbeille
    let  dos=this._srvin.rootMsgFolder.getFolderWithFlags(FLAGS_DOSSIERS.Trash);
    if (dos){
      ArchibaldTrace("SetupDossiersCompte nsMsgFolderFlags.Trash nsIMsgFolder="+dos.URI);
      this.SetupOptionDossier(dos, this.litteralIgnorer, false, true);
    }
    //dossier Indésirables
    dos=this._srvin.rootMsgFolder.getFolderWithFlags(FLAGS_DOSSIERS.Junk);
    if (dos){
      ArchibaldTrace("SetupDossiersCompte nsMsgFolderFlags.Junk nsIMsgFolder="+dos.URI);
      this.SetupOptionDossier(dos, this.litteralIgnorer, false, true);
    }
    //dossier Modèles
    dos=this._srvin.rootMsgFolder.getFolderWithFlags(FLAGS_DOSSIERS.Templates);
    if (dos){
      ArchibaldTrace("SetupDossiersCompte nsMsgFolderFlags.Templates nsIMsgFolder="+dos.URI);
      this.SetupOptionDossier(dos, this.litteralIgnorer, false, true);
    }
    //dossier Brouillons
    dos=this._srvin.rootMsgFolder.getFolderWithFlags(FLAGS_DOSSIERS.Drafts);
    if (dos){
      ArchibaldTrace("SetupDossiersCompte nsMsgFolderFlags.Drafts nsIMsgFolder="+dos.URI);
      this.SetupOptionDossier(dos, this.litteralIgnorer, false, true);
    }

    //cas boîte partagée
    if (uidIsBalp(this._srvin.username)){

      ArchibaldTrace("SetupDossiersCompte cas boite partagee this._srvin.rootMsgFolder.URI="+this._srvin.rootMsgFolder.URI);

      //positionne ignorer par défaut pour tous les sous-dossiers de la racine
      let  dos=this._srvin.rootMsgFolder;
      if (dos.hasSubFolders){

        let  subFolders=dos.subFolders;

        while (subFolders.hasMoreElements()) {

          let  suivant=subFolders.getNext().QueryInterface(Components.interfaces.nsIMsgFolder);

          ArchibaldTrace("SetupDossiersCompte cas boite partagee suivant="+suivant.URI);
          this.SetupOptionDossier(suivant, this.litteralIgnorer, false, false);
        }
      }
    }

    return true;
  },

  //Fixe l'option spécifié pour le dossier et les sous-dossiers
  //dos	instance nsIMsgFolder du dossier à traiter
  //option	litteral de l'option (litteralIgnorer,...)
  //force si false n'ecrase pas l'option si elle existe déjà
  //recur si true traite les sous-dossiers
  SetupOptionDossier: function(dos, option, force, recur) {

    ArchibaldTrace("SetupOptionDossier dos.URI="+dos.URI);

    this.FixeOptionDossier(dos, option, force);

    //sous-dossiers
    if (recur && dos.hasSubFolders){

      let  subFolders=dos.subFolders;

      while (subFolders.hasMoreElements()) {

        let  suivant=subFolders.getNext().QueryInterface(Components.interfaces.nsIMsgFolder);
        this.SetupOptionDossier(suivant, option, force, recur);
      }
    }
  },


  /* fonctions internes */

  //retourne url fichier rdf, le cree si inexistant
  InitFichierOptions: function() {

    let  chemin=ArchibaldGetProfD();
    chemin.append(ARCH_FICHIEROPTIONS);

    ArchibaldTrace("ArchibaldDossiers initFichierOptions chemin="+chemin.path);

    let  fichier=Components.classes["@mozilla.org/file/local;1"].createInstance(Components.interfaces.nsIFile);
    fichier.initWithPath(chemin.path);

    if (fichier.exists()==false){

      ArchibaldTrace("ArchibaldDossiers initFichierOptions creation du fichier");
      fichier.create(Components.interfaces.nsIFile.NORMAL_FILE_TYPE,0664);

      let  flux=Components.classes["@mozilla.org/network/file-output-stream;1"].createInstance(Components.interfaces.nsIFileOutputStream);
      flux.init(fichier,0x02|0x08|0x20, 0664,0);

      let  str="<?xml version=\"1.0\"?>"+
              "<RDF:RDF xmlns:NS1=\"http://anais.melanie2.i2/archibald#\""+
              " xmlns:NC=\"http://home.netscape.com/NC-rdf#\""+
              " xmlns:RDF=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"></RDF:RDF>";

      flux.write(str, str.length);
      flux.flush();
      flux.close();
      ArchibaldTrace("ArchibaldDossiers fichier archibald.rdf cree");
    }

    //v3.4
    let  fileHandler=Components.classes["@mozilla.org/network/io-service;1"]
                              .getService(Components.interfaces.nsIIOService)
                              .getProtocolHandler("file")
                              .QueryInterface(Components.interfaces.nsIFileProtocolHandler);
    let  url=fileHandler.getURLSpecFromFile(fichier);

    return url;
  },

  _accman: null,

  get accman() {

    if (null==this._accman) {

      this._accman=MailServices.accounts;
    }

    return this._accman;
  },

  //nsIRDFService
  _rdfService: null,

  get rdfService() {

    if (null==this._rdfService) {

      this._rdfService=Components .classes["@mozilla.org/rdf/rdf-service;1"].
                      getService(Components.interfaces.nsIRDFService);
    }

    return this._rdfService;
  },

  //predicat http://anais.melanie2.i2/archibald#mode
  _predMode: null,

  get predMode() {
    if (null==this._predMode) {

      this._predMode=this.rdfService.GetResource("http://anais.melanie2.i2/archibald#mode");
    }

    return this._predMode;
  },
  //Litteral 0 -> archiver
  _litteralArchiver: null,

  get litteralArchiver() {
    if (null==this._litteralArchiver) {

      this._litteralArchiver=this.rdfService.GetLiteral(ARCH_OPTION_ARCHIVER);
    }

    return this._litteralArchiver;
  },
  //Litteral 1	-> ignorer
  _litteralIgnorer: null,

  get litteralIgnorer() {
    if (null==this._litteralIgnorer) {

      this._litteralIgnorer=this.rdfService.GetLiteral(ARCH_OPTION_IGNORER);
    }

    return this._litteralIgnorer;
  },
  //Litteral 2 -> supprimer
  _litteralSupprimer: null,

  get litteralSupprimer() {
    if (null==this._litteralSupprimer) {

      this._litteralSupprimer=this.rdfService.GetLiteral(ARCH_OPTION_SUPPRIMER);
    }

    return this._litteralSupprimer;
  },

  //Ecouteur pour le chargement de la source de données des options
  onBeginLoad: function(aSink) {},
  onInterrupt: function(aSink) {},
  onResume: function(aSink) {},
  onEndLoad: function(aSink) {

    ArchibaldTrace("onEndLoad");

    this.datasource=aSink.QueryInterface(Components.interfaces.nsIRDFDataSource);
    aSink.removeXMLSinkObserver(this);

    if (null!=this.rappel) this.rappel();
  },
  onError: function(aSink, aStatus, aErrorMsg) {
    ArchibaldTrace("onError");
    aSink.removeXMLSinkObserver(gChargeDsOptions);

    this.msgerreur=ArchibaldMessageFromId("archibaldErrArchibaldRDF");

    if (null!=this.rappel) this.rappel();
  },

  loadDataSource: function(){

    this.datasource=null;

    //url du fichier archibald.rdf
    let  url=this.InitFichierOptions();

    ArchibaldTrace("ArchibaldDossiers loadDataSource url="+url);

    if (null==url){
      this.msgerreur=ArchibaldMessageFromId("archibaldOptionsErrRDF");
      if (null!=this.rappel) this.rappel();
      return;
    }

    //charger la source de données
    let  ds=this.rdfService.GetDataSource(url);
    let  rds=ds.QueryInterface(Components.interfaces.nsIRDFRemoteDataSource);

    if (!rds.loaded){
      let  sink=ds.QueryInterface(Components.interfaces.nsIRDFXMLSink);
      sink.addXMLSinkObserver(this);
      return;
    }
    ArchibaldTrace("ArchibaldDossiers loadDataSource datasource deja chargee.");

    this.datasource=ds;

    if (null!=this.rappel)
      this.rappel();
  },

  //parcours les sous-dossiers et positonne option
  //dos	instance nsIMsgFolder du dossier à traiter
  //option	litteral de l'option (litteralArchiver,...)
  //force si false n'ecrase pas l'option si elle existe déjà et stop la propagation
  PropageOptionSousDossiers: function(dos, option, force){

    ArchibaldTrace("PropageOptionSousDossiers dossier:"+dos.URI);

    //sous-dossiers
    if (dos.hasSubFolders) {

      let  subFolders=dos.subFolders;

      while (subFolders.hasMoreElements()) {

        let  suivant=subFolders.getNext().QueryInterface(Components.interfaces.nsIMsgFolder);

        //valeur
        let  rs=this.rdfService.GetResource(suivant.URI);
        let  obj=this.datasource.GetTarget(rs, this.predMode, true);
        if (!force && null!=obj) {
          ArchibaldTrace("PropageOptionSousDossiers stop propagation:"+suivant.URI);
          return;
        }
        if (null==obj) {
          this.datasource.Assert(rs, this.predMode, option, true);
        } else {
          this.datasource.Change(rs, this.predMode, obj, option);
        }

        //sous-dossiers
        this.PropageOptionSousDossiers(suivant, option, force);
      }
    }
  }
}



/* variables globales */
//instance ArchibaldDossiers
var gArchibaldDossiers=null;
//instance ArchibaldParamsCompte
var gArchibaldParams=null;
//arborescence des dossiers (element tree)
var gArbreDossiers=null;



/*
*	Chargement de la boite de dialogue
*
*	Argument d'appel de la boîte: 'params' instance ArchibaldParamsCompte
*/
function initDlgOptions(){

  ArchibaldTrace("initDlgOptions");

  //argument d'appel de la boite
  if (null==window.arguments || null==window.arguments[0].params){
    ArchibaldAfficheMsgId("archibaldOptionsErrAppel");
    close();
    return;
  }

  gArchibaldParams=window.arguments[0].params;

  gArbreDossiers=document.getElementById("dossiers");

  gArchibaldDossiers=new ArchibaldDossiers();

  gArchibaldDossiers.ChargeFichierOptions(initDlgOptionsRap);
}

/**
*	function de rappel pour l'initialisation de la boite d'options
*
*	@param dsmsg instance nsIRDFDataSource de la source d'options si succès
*	sinon message d'erreur
*/
function initDlgOptionsRap(){

  ArchibaldTrace("initDlgOptionsRap");

  let  msgerr=gArchibaldDossiers.GetMsgErreur();
  if (""!=msgerr) {
    let  promptService=Components.classes["@mozilla.org/embedcomp/prompt-service;1"].getService(Components.interfaces.nsIPromptService);
    promptService.alert(window, ArchibaldMessageFromId("archibaldPromptTitle"), msgerr);
    window.close();
    return;
  }

  gArchibaldDossiers.SetupDossiersCompte(gArchibaldParams.serverkey);

  // construction de la liste des dossiers
  ConstruitListeDossiers(gArchibaldDossiers._srvin);

  //libelle boite
  let  val=gArchibaldParams.libelle;
  let  lib=document.getElementById("compte");
  lib.setAttribute("value",val);
}



/**
*	Clic sur une option d'un dossier
*
*
*/
function onclicDossiers(event){

  if (event.button != 0)
      return;
  let  row = {}
  let  col = {}
  let  elt = {}

  gArbreDossiers.treeBoxObject.getCellAt(event.clientX, event.clientY, row, col, elt);
  if (row.value == -1)
    return;

  let  idcol=col.value.id;

  if ("colmode"==idcol) {

    ArchibaldTrace("onclicDossiers row:"+row.value);

    let dossier=gFolderTreeView._rowMap[row.value]._folder;

    if (dossier.isServer)
      return;

    ArchibaldTrace("onclicDossiers dossier:"+dossier.URI);

    gArchibaldDossiers.SetDossierNextVal(dossier);
  }
}


function boutonAnnuler(){

  gArchibaldDossiers.AnnuleModifs();

  window.close();
}

function boutonValider(){

  gArchibaldDossiers.ValideModifs();

	window.close();
}


// construction de la liste des dossiers
// serveur : serveur entrant du compte
function ConstruitListeDossiers(serveur){

  if (null==serveur)
    return;

  gListeDossiers.load(serveur);
}


var gListeDossiers={

  _treeElement: null,

  //liste des dossiers du serveur
  listedossiers: [],

  load: function(serveur) {

    let oldProps=ftvItem.prototype.getProperties;
    ftvItem.prototype.getProperties = function(aColumn) {

      if (!aColumn || aColumn.id!="colmode")
        return oldProps.call(this, aColumn);

      let uridos=this._folder.URI;

      let option=gArchibaldDossiers.LitOptionDossierVal(uridos);

      let properties="optiondossier-"+option;

      return properties;
    }

    let optionsArchibald={

      _this:null,

      __proto__: IFolderTreeMode,

      generateMap: function(ftv) {

        let filterOffline = function(aFolder) { return aFolder.supportsOffline; }

        return this._this.listedossiers;
      }
    };

    MailUtils.discoverFolders();

    this.setupListeDossiers(serveur);

    optionsArchibald._this=this;

    this._treeElement=document.getElementById("dossiers");

    gFolderTreeView.registerFolderTreeMode(this._treeElement.getAttribute("mode"),
                                           optionsArchibald,
                                           "Options d'archivage");

    gFolderTreeView.load(this._treeElement);

  },

  setupListeDossiers: function(serveur) {

    let racine=new ftvItem(serveur.rootFolder);
    for (var f of racine.children){
      this.listedossiers.push(f);
    }
  },
}
