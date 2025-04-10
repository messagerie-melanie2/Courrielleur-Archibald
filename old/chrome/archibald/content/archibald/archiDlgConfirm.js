
/* parametres d'appel
* bal: libelle de boite
* dossier : libelle du dossier si archivage d'un dossier
* jours
*
* return : 1 si oui + jours dans les parametres
*/
function initDlgConfirm() {

  if (!window.arguments || !window.arguments[0])
    close();

  let  bal=window.arguments[0].bal;
  let  dossier=window.arguments[0].dossier;
  let  jours=window.arguments[0].jours;
  let  uid=window.arguments[0].uid;
  if (null==jours)
    jours=archi_jours;

  ArchibaldTrace("initDlgConfirm bal:"+bal);
  ArchibaldTrace("initDlgConfirm uid:"+uid);
  ArchibaldTrace("initDlgConfirm dossier:"+dossier);
  ArchibaldTrace("initDlgConfirm jours:"+jours);

  let  msg;
  if (uidIsDossier(uid)){
    if (dossier && ""!=dossier) {

      msg=ArchibaldFormatStringFromName("dlgconfirmDossier2", [dossier], 1);
      document.title=ArchibaldMessageFromId("dlgconfirmTitredossier");
      //option sous-dossiers
      let  sousctrl=document.getElementById("sousdossiers");
      sousctrl.removeAttribute("hidden");
      if (null!=window.arguments[0].sousdossiers)
        sousctrl.checked=window.arguments[0].sousdossiers;
    } else {
      msg=ArchibaldMessageFromId("archibaldConfirmDossier");
    }
    document.title=ArchibaldMessageFromId("dlgconfirmTitreDossiers");

  } else{

    if (dossier && ""!=dossier) {
      msg=ArchibaldFormatStringFromName("dlgconfirmDossier", [dossier], 1);
      document.title=ArchibaldMessageFromId("dlgconfirmTitredossier");
      //option sous-dossiers
      let  sousctrl=document.getElementById("sousdossiers");
      sousctrl.removeAttribute("hidden");
      if (null!=window.arguments[0].sousdossiers)
        sousctrl.checked=window.arguments[0].sousdossiers;
    } else {
      msg=ArchibaldMessageFromId("archibaldConfirm1");
    }
  }

  let  lib1=document.getElementById("dlgconfirm-question1");
  lib1.value=msg;
  let  lib2=document.getElementById("dlgconfirm-question2");
  lib2.value=bal+" ?";

  getCtrlJours().value=jours;

  initdatepicker(jours);

  document.getElementById("dlgconfirmok").focus();
}

function dlgConfirmOK() {

  window.arguments[0].jours=getCtrlJours().value;
  window.arguments[0].sousdossiers=document.getElementById("sousdossiers").checked;
  window.arguments[0].res=1;
  window.close();
}

function dlgConfirmNO() {
  window.arguments[0].res=0;
  window.close();
}
