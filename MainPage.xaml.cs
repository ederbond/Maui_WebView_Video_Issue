namespace Maui_WebView;

public partial class MainPage : ContentPage
{
	public MainPage()
	{
		InitializeComponent();

        var html = MyResources.Html;

        MyWebView.Source = new HtmlWebViewSource()
        {
            Html = html
        };
    }
}

