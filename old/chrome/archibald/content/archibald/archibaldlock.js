
//config: instance ArchibaldParamsCompte
function archibaldLock(config) {

  this.config=config;
}

archibaldLock.prototype={

  //config: instance ArchibaldParamsCompte
  config: null,

  //dossier racine d'archivage
  dossierdest_racine: null,

  //fichier verrou pour les boites partagees
  fichierverrou: null,

  //verrou d'archivage pour les boites partagees
  verrouArchivage: function() {

    if (null==this.config ||
        this.config.isBali()||
        this.config.isDossier()) {
      //pas de verrou sur les bali et dossiers
      return true;
    }

    let  dossier=this.getDossierRacineArchive();
    if (null==dossier) {
      ArchibaldTrace("Erreur dans l'initialisation du dossier d'archivage");
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Erreur dans l'initialisation du dossier d'archivage", this.config.dossier);
      return false;
    }

    ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Tentative de verrouillage du dossier d'archive", "");

    try{

      let  file=Components.classes["@mozilla.org/file/local;1"].createInstance(Components.interfaces.nsIFile);
      file.initWithFile(dossier.filePath);

      let  nomfic=ArchibaldMessageFromId("archibaldFichierVerrou");
      file.appendRelativePath(nomfic);

      ArchibaldTrace("FixeVerrouArchive chemin:"+file.path);
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Chemin du fichier de verouillage", file.path);

      if (!file.exists()){
        //première tentative de création du fichier verrou
        try{
          this.fichierverrou=Components.classes["@mozilla.org/network/file-output-stream;1"].createInstance(Components.interfaces.nsIFileOutputStream);
          this.fichierverrou.init(file,0x8C,00777,0);
        }
        catch(ex){
          this.fichierverrou=null;
        }
        if (null!=this.fichierverrou){
          ArchibaldTrace("FixeVerrouArchive fichier cr\u00E9\u00E9:"+file.path);
          ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Chemin du fichier de verouillage cree", "");
          return true;
        }
      }
      if (file.exists()){

        let  tps=new Date();
        tps=tps.getTime();
        let  delta=tps-file.lastModifiedTime;
        ArchibaldTrace("FixeVerrouArchive fichier existant depuis:"+delta);
        ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Fichier de verouillage existant depuis:", delta);
        //si dernière modification > 30 minutes suppprimer le fichier
        if (delta>1800000){
          ArchibaldTrace("FixeVerrouArchive suppression:"+file.path);
          ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Fichier suppression du fichier de verouillage", "");
          file.remove(false);
        }
        if (file.exists()){
          let  delai=1800000-delta;
          delai/=60000;

          let  msg="(D\u00E9lai d'attente: "+Math.round(delai)+" minutes)";
          ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Delai d'attente du fichier de verouillage", msg);
          ArchibaldAfficheMsgId2("archibaldVerrouExiste",msg);
          this.msgerreur=ArchibaldMessageFromId("archibaldVerrouExiste");
          return false;
        }
      }

      this.fichierverrou=Components.classes["@mozilla.org/network/file-output-stream;1"].createInstance(Components.interfaces.nsIFileOutputStream);
      this.fichierverrou.init(file,0x8C,00777,0);

      return true;

    }	catch(ex){
      ArchibaldTrace("FixeVerrouArchive exception"+ex);
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Erreur imprevue lors du verrouillage du dossier d'archive", ex);
      this.msgerreur=ArchibaldMessageFromId("archibaldVerrou");
    }
    return false;
  },

  libereVerrouArchivage: function() {

    if (null==this.fichierverrou)
      return;

    let  dossier=this.getDossierRacineArchive();

    try{

      this.fichierverrou.close();
      this.fichierverrou=null;

      let  file=Components.classes["@mozilla.org/file/local;1"].createInstance(Components.interfaces.nsIFile);
      file.initWithFile(dossier.filePath);
      let  nomfic=ArchibaldMessageFromId("archibaldFichierVerrou");
      file.appendRelativePath(nomfic);
      ArchibaldTrace("LibereVerrouArchive chemin:"+file.path);

      if (file.exists()){
        ArchibaldTrace("LibereVerrouArchive suppression");
        ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Suppression du fichier verrou", file.path);
        file.remove(false);
      }
    }
    catch(ex){
      ArchibaldTrace("LibereVerrouArchive exception",ex);
      ArchibaldEcritLog(ARCHIBALD_LOGS_MODULE, "Erreur imprevue lors de la suppression du fichier verrou", ex);
    }
  },
  
  //return true si ok
  majVerrouArchivage: function() {

    ArchibaldTrace("majVerrouArchivage");
    if (null==this.fichierverrou){
      //pas une erreur, est appelee dans tous les cas meme si verrouArchivage ne fixe pas de verrou (bali)
      return true;
    }

    let  txt="//";
    try {

      let  l=txt.length;
      let  res=this.fichierverrou.write(txt, l);
      if (res!=l){
        ArchibaldTrace("majVerrouArchivage erreur write res:"+res+" - l:"+l);
        return false;
      }
      this.fichierverrou.flush();

      return true;

    } catch(ex) {
      ArchibaldTrace("majVerrouArchivage exception write:"+ex);
    }

    return false;
  },

  //dossier racine d'archivage
  //dossier racine de la configuration courante
  getDossierRacineArchive: function(){

    if (null!=this.dossierdest_racine) {
      return this.dossierdest_racine;
    }

    let  serveur=ArchiGetSrvDossier(this.config.dossier);
    if (null==serveur)
      return null;
    this.dossierdest_racine=serveur.rootMsgFolder;

    return this.dossierdest_racine;
  }
}