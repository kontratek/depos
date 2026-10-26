using Depos.Core.Org;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Depos.VisualStudio.Tests;

[TestClass]
public sealed class DeposConnectionModelTests
{
    [TestMethod]
    public void TheAllowlistBadgeHasTheOtherEditorsColors()
    {
        Assert.AreEqual(0x00662f, DeposBadgePalette.For(OrgResultKind.Allowed, darkTheme: false).BackgroundRgb);
        Assert.AreEqual(0xffffff, DeposBadgePalette.For(OrgResultKind.Allowed, darkTheme: false).ForegroundRgb);
        Assert.AreEqual(0x00ff66, DeposBadgePalette.For(OrgResultKind.Allowed, darkTheme: true).BackgroundRgb);
        Assert.AreEqual(0x0a0a0a, DeposBadgePalette.For(OrgResultKind.Allowed, darkTheme: true).ForegroundRgb);
        Assert.AreEqual(0xf2c200, DeposBadgePalette.For(OrgResultKind.Unlisted, darkTheme: true).BackgroundRgb);
        Assert.AreEqual(0x1a1a1a, DeposBadgePalette.For(OrgResultKind.Unlisted, darkTheme: false).ForegroundRgb);
        Assert.AreEqual(0xc72e2e, DeposBadgePalette.For(OrgResultKind.Denied, darkTheme: false).BackgroundRgb);
    }

    [TestMethod]
    public void TheTokenIsKeptPerOriginInCredentialManager()
    {
        var store = new WindowsCredentialStore();
        var origin = "https://depos-test-" + Guid.NewGuid().ToString("N") + ".example.com";
        try
        {
            Assert.IsNull(store.Read(origin));
            store.Write(origin, "tok-1");
            Assert.AreEqual("tok-1", store.Read(origin));
            store.Write(origin, "tok-2");
            Assert.AreEqual("tok-2", store.Read(origin));
            Assert.IsNull(store.Read(origin + ":8443"));
        }
        finally
        {
            store.Write(origin, null);
        }
        Assert.IsNull(store.Read(origin));
        // Removing what is not there is not an error.
        store.Write(origin, null);
    }

    [TestMethod]
    public void OnlyWebAddressesAreOpenedInTheBrowser()
    {
        // Nothing to open: a scheme other than http or https from a server answer is ignored before it reaches the shell.
        DeposService.OpenBrowser("file:///C:/Windows/System32/calc.exe");
        DeposService.OpenBrowser("javascript:alert(1)");
        DeposService.OpenBrowser("not a url");
    }
}
